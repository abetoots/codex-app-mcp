// composes thread/start | thread/resume -> turn/start against an AppServerClient, collects the
// agentMessage items a turn produces, and answers the approval/input requests the app-server
// sends mid-turn. this is the layer tools.ts (task 6) calls; it knows nothing about MCP.
import type { AppServerClient, AppServerExited } from "./app-server-client.js";
import { CLIENT_REQUESTS, SERVER_NOTIFICATIONS, type ServerRequestMethod } from "./protocol.js";
import { DECLINE_RESPONSES } from "./responses.js";

export interface ThreadSettings {
  cwd?: string;
  // already mapped from kebab-case + on-failure->on-request by the caller (task 6); TurnRunner
  // takes the app-server-shaped value as-is.
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export interface StartThreadOptions extends ThreadSettings {
  model?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
}

export interface RunTurnOptions {
  timeoutMs?: number;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  text: string;
  errorText?: string;
  declinedRequests: string[];
  // every `error` notification app-server sent during this turn, in arrival order. always
  // present (possibly empty) -- see extractUpstreamError's comment for why this is captured
  // instead of discarded, even for a turn that otherwise completed successfully.
  upstreamErrors: { message: string; code?: string }[];
}

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes

interface AgentMessage {
  text: string;
  isFinal: boolean;
}

interface CompletedTurn {
  id: string;
  status: string;
  error?: { message: string } | null;
}

// picks the text a caller should see for a turn: the last agentMessage item whose
// phase is "final_answer", or -- when none carried that phase -- every agentMessage
// item's text joined by a blank line.
function selectFinalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.isFinal) return message.text;
  }
  return messages.map((message) => message.text).join("\n\n");
}

// both extractors also reject any event whose turnId doesn't match the turn currently in
// flight -- see the "stale-turn-after-timeout" fake-server scenario for the race this guards
// against: a timed-out turn's late item/completed/turn/completed must never be mistaken for
// its successor's, since the app-server never confirmed the old turn actually stopped.
function extractAgentMessage(params: unknown, threadId: string, turnId: string | undefined): AgentMessage | undefined {
  const p = params as {
    threadId?: string;
    turnId?: string;
    item?: { type?: string; phase?: string | null; text?: string };
  };
  if (p?.threadId !== threadId) return undefined;
  if (p?.turnId !== turnId) return undefined;
  const item = p.item;
  if (!item || item.type !== "agentMessage" || typeof item.text !== "string") return undefined;
  return { text: item.text, isFinal: item.phase === "final_answer" };
}

function extractCompletedTurn(params: unknown, threadId: string, turnId: string | undefined): CompletedTurn | undefined {
  const p = params as { threadId?: string; turn?: CompletedTurn };
  if (p?.threadId !== threadId || !p.turn) return undefined;
  if (p.turn.id !== turnId) return undefined;
  return p.turn;
}

// same turnId-scoping discipline as the two extractors above: an `error` notification for a
// stale, timed-out turn must not be attributed to its successor on the same thread.
//
// this notification used to be discarded entirely (a bare `error` is never terminal by itself
// -- turn/completed is the only thing that ends a turn, per the app-server v2 schema -- so there
// was "nothing to do" with it). that was wrong: when a turn completes with status:"completed"
// but zero text, this is the one piece of evidence app-server sends explaining why, and
// `codexErrorInfo` carries a structured, machine-readable reason (usageLimitExceeded,
// rateLimitExceeded, contextWindowExceeded, sessionBudgetExceeded, ...) when the upstream error
// is one of those. Capturing it turns a silent, undiagnosable failure into one with real
// evidence -- see tools.ts's isEmptyCompletion handling, which surfaces this to the caller.
function extractUpstreamError(
  params: unknown,
  threadId: string,
  turnId: string | undefined,
): { message: string; code?: string } | undefined {
  const p = params as {
    threadId?: string;
    turnId?: string;
    error?: { message?: string; codexErrorInfo?: unknown };
  };
  if (p?.threadId !== threadId || p?.turnId !== turnId) return undefined;
  const message = p.error?.message;
  if (typeof message !== "string") return undefined;
  // codexErrorInfo is a oneOf: either a plain string enum (usageLimitExceeded, etc.) or an
  // object variant carrying an httpStatusCode. only the string form maps cleanly to a `code`;
  // the object form is left out rather than guessed at.
  const code = typeof p.error?.codexErrorInfo === "string" ? p.error.codexErrorInfo : undefined;
  return code !== undefined ? { message, code } : { message };
}

export class TurnRunner {
  // thread ids this instance itself created or resumed -- ensureThread() is a no-op for these
  private readonly knownThreadIds = new Set<string>();
  // one queued promise per threadId, so a second runTurn() on the same thread waits for the
  // first to settle; different threads get independent queues and run concurrently.
  private readonly threadLocks = new Map<string, Promise<unknown>>();
  // one in-flight thread/resume promise per threadId, so two concurrent ensureThread() calls
  // for the same never-before-seen id share a single thread/resume instead of both firing one.
  private readonly ensureThreadLocks = new Map<string, Promise<void>>();
  // declinedRequests list for whichever turn is currently active on a given threadId, so the
  // single onServerRequest dispatcher below knows where to record a decline.
  private readonly activeDeclines = new Map<string, string[]>();

  constructor(private readonly client: AppServerClient) {
    this.client.onServerRequest((method, params) => this.handleServerRequest(method, params));
  }

  async startThread(options: StartThreadOptions): Promise<{ threadId: string }> {
    const result = await this.client.request<{ thread: { id: string } }>(CLIENT_REQUESTS.threadStart, {
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandbox,
      model: options.model,
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
      config: options.config,
    });
    const threadId = result.thread.id;
    this.knownThreadIds.add(threadId);
    return { threadId };
  }

  // no-op when this instance already knows threadId is live (it started or resumed it itself);
  // otherwise calls thread/resume so a thread from a previous process can be continued.
  async ensureThread(threadId: string, fallback: ThreadSettings): Promise<void> {
    if (this.knownThreadIds.has(threadId)) return;

    // a second concurrent call for the same id joins the first's in-flight thread/resume
    // instead of sending its own -- mirrors threadLocks' per-thread serialization above.
    const pending = this.ensureThreadLocks.get(threadId);
    if (pending) return pending;

    const promise = (async (): Promise<void> => {
      await this.client.request(CLIENT_REQUESTS.threadResume, {
        threadId,
        cwd: fallback.cwd,
        approvalPolicy: fallback.approvalPolicy,
        sandbox: fallback.sandbox,
      });
      this.knownThreadIds.add(threadId);
    })();

    this.ensureThreadLocks.set(threadId, promise);
    try {
      await promise;
    } finally {
      this.ensureThreadLocks.delete(threadId);
    }
  }

  // runs one turn on threadId. concurrent calls for the SAME threadId are serialized: the next
  // one's turn/start isn't sent until the previous turn has settled. different threadIds are
  // independent and may run at the same time.
  runTurn(threadId: string, prompt: string, options: RunTurnOptions = {}): Promise<TurnResult> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    const run = previous.then(
      () => this.runTurnOnce(threadId, prompt, options),
      () => this.runTurnOnce(threadId, prompt, options),
    );
    // never let a rejection here block the next queued turn; the rejection itself still
    // propagates to whoever is awaiting the `run` promise this method returns.
    this.threadLocks.set(
      threadId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private runTurnOnce(threadId: string, prompt: string, options: RunTurnOptions): Promise<TurnResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const declinedRequests: string[] = [];
    this.activeDeclines.set(threadId, declinedRequests);

    const messages: AgentMessage[] = [];
    const upstreamErrors: { message: string; code?: string }[] = [];
    let turnId: string | undefined;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const disposers: Array<() => void> = [];

    return new Promise<TurnResult>((resolve, reject) => {
      const cleanup = (): void => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        for (const dispose of disposers) dispose();
        this.activeDeclines.delete(threadId);
      };

      const finish = (result: TurnResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      disposers.push(
        this.client.on(SERVER_NOTIFICATIONS.itemCompleted, (params) => {
          // turnId is read here (not captured at registration time) so this listener tracks
          // whichever turn is currently expected -- undefined until turn/start's response
          // resolves, which per the protocol's request/response-then-notification ordering is
          // always before any genuine notification for this turn can arrive.
          const message = extractAgentMessage(params, threadId, turnId);
          if (message) messages.push(message);
        }),
      );

      disposers.push(
        this.client.on(SERVER_NOTIFICATIONS.turnCompleted, (params) => {
          const turn = extractCompletedTurn(params, threadId, turnId);
          if (!turn) return;
          if (turn.status === "failed") {
            finish({
              threadId,
              turnId: turn.id,
              status: "failed",
              text: "",
              errorText: turn.error?.message ?? "turn failed",
              declinedRequests,
              upstreamErrors,
            });
            return;
          }
          const status = turn.status === "interrupted" ? "interrupted" : "completed";
          finish({
            threadId,
            turnId: turn.id,
            status,
            text: selectFinalText(messages),
            declinedRequests,
            upstreamErrors,
          });
        }),
      );

      // a bare `error` notification (willRetry true or false) is never terminal by itself in
      // the app-server v2 schema -- a turn only ends via turn/completed, which reports
      // status:"failed" when it doesn't recover, so this alone never calls finish()/fail().
      // it IS captured, though (see extractUpstreamError) rather than discarded: it's the one
      // piece of evidence app-server sends when a turn later completes successfully but with no
      // text, and retries just keep the turn running until turn/completed arrives regardless.
      disposers.push(
        this.client.on(SERVER_NOTIFICATIONS.error, (params) => {
          const upstreamError = extractUpstreamError(params, threadId, turnId);
          if (upstreamError) upstreamErrors.push(upstreamError);
        }),
      );

      disposers.push(this.client.onExit((err: AppServerExited) => fail(err)));

      this.client
        .request<{ turn: { id: string } }>(
          CLIENT_REQUESTS.turnStart,
          { threadId, input: [{ type: "text", text: prompt }] },
          // onSettled, NOT .then(): it runs synchronously the instant turn/start's response is
          // parsed, before any microtask. a stdout chunk (or run of chunks processed before the
          // microtask queue drains) can contain this response line immediately followed by this
          // same turn's own item/completed/turn/completed notification -- onStdoutData dispatches
          // notifications synchronously, in order, in the same loop. a .then() callback would
          // still be queued (not yet run) when that notification is dispatched, so turnId would
          // still read undefined and extractAgentMessage/extractCompletedTurn would drop the
          // event. setting turnId here closes that gap.
          (result) => {
            turnId = result.turn.id;
            timeoutHandle = setTimeout(() => {
              const interruptTurnId = turnId as string;
              void this.client.request(CLIENT_REQUESTS.turnInterrupt, { threadId, turnId: interruptTurnId }).catch(() => {
                // best effort -- we're synthesizing the result below regardless
              });
              finish({
                threadId,
                turnId: interruptTurnId,
                status: "interrupted",
                text: selectFinalText(messages),
                declinedRequests,
                upstreamErrors,
              });
            }, timeoutMs);
          },
        )
        .catch((err: Error) => fail(err));
    });
  }

  // the single onServerRequest dispatcher for the underlying client. recognizes exactly the
  // methods in DECLINE_RESPONSES (see src/responses.ts); anything else returns undefined so
  // AppServerClient answers with its own -32601 instead.
  private handleServerRequest(method: string, params: unknown): unknown {
    const response = DECLINE_RESPONSES[method as ServerRequestMethod];
    if (response === undefined) return undefined;

    const p = params as { threadId?: string; conversationId?: string } | undefined;
    const threadKey = p?.threadId ?? p?.conversationId;
    if (threadKey) this.activeDeclines.get(threadKey)?.push(method);

    return response;
  }
}
