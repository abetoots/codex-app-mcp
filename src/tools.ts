// zod schemas + handlers for the `codex` / `codex-reply` tools, re-exposing the removed `codex
// mcp-server`'s 0.151.0 field set over a TurnRunner so the multi-model/gauntlet skills need zero
// changes. knows nothing about stdio/child-process wiring -- src/index.ts owns that.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { GrantClient, GrantDecision, GrantRequest } from "./grant-client.js";
import type { BindingStore, ThreadBinding } from "./thread-binding.js";
import type { RunTurnOptions, StartThreadOptions, SupportedEfforts, ThreadSettings, TurnResult } from "./turn-runner.js";

// the subset of TurnRunner's public surface these tools call -- a structural interface (rather
// than importing the TurnRunner class type itself) so src/index.ts's lazy-spawn/respawn wrapper
// (which is not, and cannot cheaply be, an actual TurnRunner instance) can be passed in too.
export interface TurnRunnerLike {
  startThread(options: StartThreadOptions): Promise<{ threadId: string }>;
  ensureThread(threadId: string, settings: ThreadSettings): Promise<void>;
  runTurn(threadId: string, prompt: string, options?: RunTurnOptions): Promise<TurnResult>;
  supportedEfforts(target: { model?: string; threadId?: string }): Promise<SupportedEfforts | undefined>;
}

// rejects an effort the target model doesn't advertise, before any turn is sent -- codex would
// store it on the thread and fail every later turn. undefined when the effort is fine, unset, or
// can't be checked (unknown model, lookup failure): validation never blocks on its own failure.
async function effortError(
  turnRunner: TurnRunnerLike,
  effort: string | undefined,
  target: { model?: string; threadId?: string },
): Promise<string | undefined> {
  if (effort === undefined) return undefined;
  const supported = await turnRunner.supportedEfforts(target);
  if (!supported || supported.efforts.includes(effort)) return undefined;
  return (
    `effort "${effort}" is not supported by model ${supported.model}; supported values: ` +
    `${supported.efforts.join(", ")}. Nothing was sent to Codex.`
  );
}

// what the tools need to bind a thread to its project and grant: where bindings live, and the
// grant checker (only `check` is used, so a test can hand in a stub).
export interface BindingDeps {
  bindings: BindingStore;
  grants: Pick<GrantClient, "check">;
}

const CONFIG_UNSUPPORTED_TEXT =
  "the `config` field is not supported: a thread gets its MCP servers only from the project's " +
  "files, never from the caller. Drop `config` from the request. Nothing was sent to Codex.";

const NO_BINDING_TEXT =
  "this thread has no readable binding (it was started before bindings existed, by another " +
  "state directory, or its record is damaged), so it cannot be resumed. Start a new `codex` thread.";

const SCOPE_CHANGED_TEXT =
  "the project's standing scope changed since this thread started; start a new `codex` thread.";

// the real path when the directory exists, else just the resolved one (thread/start then fails
// on it as before)
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// the checker's decision, or an error: a denied decision, an unreachable checker, and (when the
// thread is already bound) a changed standing scope all stop the call.
async function allowedDecision(deps: BindingDeps, req: GrantRequest, boundHash?: string): Promise<GrantDecision> {
  let decision: GrantDecision;
  try {
    decision = await deps.grants.check(req);
  } catch (err) {
    throw new Error(`grant check failed: ${errorMessage(err)}. Nothing was sent to Codex.`);
  }
  if (!decision.allowed) throw new Error(`refused by the grant check (${decision.reason}). Nothing was sent to Codex.`);
  if (boundHash !== undefined && decision.effectiveHash !== boundHash) throw new Error(SCOPE_CHANGED_TEXT);
  return decision;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// how often to send a keepalive notifications/progress while a turn is in flight, when the
// caller asked for one (via _meta.progressToken on the tool call).
const PROGRESS_INTERVAL_MS = 10_000;

const PROFILE_UNSUPPORTED_TEXT =
  "the `profile` field has no equivalent in codex app-server's ThreadStartParams (the thread/start " +
  "request codex-app-mcp sends), so it is not supported here. Drop `profile` from the request " +
  "and use `model` instead.";

// `on-failure` was removed from codex app-server's ApprovalPolicy; codex-app-mcp treats it as
// `on-request` and says so in the result text rather than failing the call outright.
const ON_FAILURE_NOTE =
  "(note: approval-policy 'on-failure' is no longer supported by codex app-server; treated as 'on-request')";

// `compact-prompt` has no field of its own in ThreadStartParams. rather than silently dropping
// it, its value is folded into developer-instructions (appended, separated by a blank line) --
// documented here and called out in the result text so callers aren't surprised.
const COMPACT_PROMPT_NOTE =
  "(note: compact-prompt has no dedicated field in codex app-server's ThreadStartParams; its " +
  "value was appended to developer-instructions)";

const SYNTHETIC_INTERRUPTED_TEXT = "turn was interrupted after timeout";

// a "completed" turn whose final text is empty/whitespace-only is treated as an error, not an
// ordinary success. Observed in the field (ledger verdict:"stale-context", 2026-09-14): codex
// tool calls, including trivial one-word prompts, repeatedly returned only the structuredContent
// envelope with zero assistant text and no error -- an LLM turn producing literally nothing is
// almost never intentional, and letting it through as a normal success would let a caller (e.g.
// a multi-model skill's verdict protocol) silently treat a stale/degraded leg as a real,
// contentless "no objections" answer instead of a failure worth surfacing.
//
// CORRECTION (2026-10-07): the field reports cited above were NOT this case. codex had returned
// text every time; claude code dropped it because structuredContent lacked a `content` mirror
// (see buildStructuredContent). this guard stays, since a genuinely empty completion is still a
// real upstream possibility (below), but it never fired for those reports.
//
// This is a confirmed, still-open upstream app-server bug class, not speculation: see
// openai/codex#25619 ("app-server: silent turn/completed(last_agent_message=null) when
// run_turn early-returns after compaction failure" -- the issue reporter explicitly confirms
// this is app-server-specific, distinct from a related but separately-caused codex-exec issue,
// openai/codex#24536). Live reproduction of #25619 was attempted (four tries: two matching
// openai/codex#45361's config-override-hang repro exactly, two escalating attempts to force a
// context-full/compaction-failure state via a tiny model_context_window override and then a
// genuinely large ~76k-token prompt) and did not trigger either bug -- the real context window
// here clamps to 258,400 tokens (matching openai/codex#16068's report of that same clamp), and
// per #25619 itself, reaching context-full doesn't reliably trigger the *failure* branch of
// compaction, only sometimes. The fix here doesn't depend on reproducing the exact trigger: it
// treats the symptom (empty text on a reported success) as untrustworthy regardless of cause.
const EMPTY_COMPLETION_TEXT =
  "the turn completed but produced no text response -- this usually indicates a stale or " +
  "degraded app-server session (e.g. after a prior usage-limit error) rather than a genuine " +
  "empty answer. Retry, or start a fresh `codex` thread instead of continuing this one.";

function isEmptyCompletion(turnResult: TurnResult): boolean {
  return turnResult.status === "completed" && turnResult.text.trim() === "";
}

// when app-server sent a real error notification during the turn (see TurnRunner's
// extractUpstreamError), surface that actual reason instead of the generic guess above --
// this is what turns a silent, undiagnosable failure into one with real evidence next time.
function emptyCompletionText(turnResult: TurnResult): string {
  if (turnResult.upstreamErrors.length === 0) return EMPTY_COMPLETION_TEXT;
  const reasons = turnResult.upstreamErrors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).join("\n");
  return `the turn completed but produced no text response. app-server reported:\n${reasons}`;
}

const APPROVAL_POLICY_MAP = {
  untrusted: "untrusted",
  "on-request": "on-request",
  never: "never",
  "on-failure": "on-request",
} as const;

// --- shared result shaping ---------------------------------------------------------------

// turnResult.text, prefixed with any notes accumulated while mapping the input (on-failure,
// compact-prompt); when the turn didn't complete, the error text is appended too.
function buildContentText(turnResult: TurnResult, notes: string[]): string {
  const parts = [...notes];
  if (turnResult.status === "completed") {
    parts.push(isEmptyCompletion(turnResult) ? emptyCompletionText(turnResult) : turnResult.text);
  } else {
    const errorText = turnResult.errorText ?? SYNTHETIC_INTERRUPTED_TEXT;
    parts.push(turnResult.text ? `${turnResult.text}\n\n${errorText}` : errorText);
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}

// `content` mirrors the same text returned in the MCP `content` block. the original codex
// mcp-server did this on purpose (codex_tool_runner.rs, rust-v0.151.0: "Some MCP clients ignore
// `content` when `structuredContent` is present, so mirror the text there as well"), and claude
// code is one of those clients: without the mirror the calling model sees only the metadata
// envelope and no answer. omitting it was the root cause of every "completed with no text"
// field report between 2026-09-14 and 2026-10-07 -- codex had answered each time.
function buildStructuredContent(turnResult: TurnResult, contentText: string): Record<string, unknown> {
  const structuredContent: Record<string, unknown> = {
    content: contentText,
    threadId: turnResult.threadId,
    turnId: turnResult.turnId,
    status: turnResult.status,
    declinedRequests: turnResult.declinedRequests,
    upstreamErrors: turnResult.upstreamErrors,
  };
  if (turnResult.errorText !== undefined) structuredContent.errorText = turnResult.errorText;
  else if (isEmptyCompletion(turnResult)) structuredContent.errorText = emptyCompletionText(turnResult);
  return structuredContent;
}

function buildToolResult(turnResult: TurnResult, notes: string[]): CallToolResult {
  const contentText = buildContentText(turnResult, notes);
  const result: CallToolResult = {
    content: [{ type: "text", text: contentText }],
    structuredContent: buildStructuredContent(turnResult, contentText),
  };
  if (turnResult.status !== "completed" || isEmptyCompletion(turnResult)) result.isError = true;
  return result;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// runTurn rejected (AppServerRpcError from turn/start itself, or AppServerExited if the child
// died mid-turn). threadId is included only when the caller already had one -- i.e. startThread
// succeeded and it was runTurn that failed, so the thread is still alive server-side.
function buildRejectedResult(err: unknown, threadId: string | undefined, notes: string[]): CallToolResult {
  const message = errorMessage(err);
  const text = [...notes, message].filter((part) => part.length > 0).join("\n\n");
  const structuredContent: Record<string, unknown> = { content: text, errorText: message };
  if (threadId !== undefined) structuredContent.threadId = threadId;
  return { isError: true, content: [{ type: "text", text }], structuredContent };
}

// runs a turn, sending a best-effort notifications/progress every ~10s while it's in flight if
// the caller supplied a progressToken. a failure to deliver a progress notification (e.g. the
// client already disconnected) never fails the turn itself.
function runTurnWithProgress(
  turnRunner: TurnRunnerLike,
  threadId: string,
  prompt: string,
  runOptions: RunTurnOptions,
  extra: ToolExtra,
): Promise<TurnResult> {
  const progressToken = extra._meta?.progressToken;
  const run = turnRunner.runTurn(threadId, prompt, runOptions);

  if (progressToken !== undefined) {
    let progress = 0;
    const timer = setInterval(() => {
      progress += 1;
      void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress } }).catch(() => {
        // best effort -- an already-closed connection shouldn't fail the turn
      });
    }, PROGRESS_INTERVAL_MS);
    const clear = (): void => clearInterval(timer);
    run.then(clear, clear);
  }

  return run;
}

// --- `codex` -------------------------------------------------------------------------------

// app-server applies per-turn model/effort to "this turn and subsequent turns" of the thread.
const EFFORT_DESCRIPTION =
  "Reasoning effort, as a value the model supports (for example low, medium, high, xhigh). " +
  "Applies to this turn and every later turn in the thread. Omit to use the default from the " +
  "Codex config (~/.codex/config.toml).";

const codexInputShape = {
  prompt: z.string(),
  model: z
    .string()
    .optional()
    .describe("Model for the new thread, for example gpt-6.1-sol. Omit to use the default from the Codex config."),
  effort: z.string().min(1).optional().describe(EFFORT_DESCRIPTION),
  profile: z.string().optional(),
  cwd: z.string().optional(),
  grant: z.string().optional().describe("Id of a session grant that binds this thread to a project, from `bin/grant issue`."),
  "approval-policy": z.enum(["untrusted", "on-failure", "on-request", "never"]).default("never"),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
  config: z.record(z.string(), z.unknown()).optional(),
  "base-instructions": z.string().optional(),
  "developer-instructions": z.string().optional(),
  "compact-prompt": z.string().optional(),
  "timeout-seconds": z.number().int().positive().default(900),
};

export function createCodexTool(turnRunner: TurnRunnerLike, deps: BindingDeps): {
  name: string;
  description: string;
  inputSchema: typeof codexInputShape;
  handler: ToolCallback<typeof codexInputShape>;
} {
  const handler: ToolCallback<typeof codexInputShape> = async (input, extra) => {
    if (input.profile !== undefined) {
      return { isError: true, content: [{ type: "text", text: PROFILE_UNSUPPORTED_TEXT }] };
    }

    if (input.config !== undefined) {
      return { isError: true, content: [{ type: "text", text: CONFIG_UNSUPPORTED_TEXT }] };
    }

    // a thread without a cwd would run wherever app-server happens to be; bind it to ours
    const cwd = realPath(input.cwd ?? process.cwd());
    const startRequest: GrantRequest = {
      phase: "start",
      harness: "codex",
      cwd,
      addDirs: [],
      grantId: input.grant ?? null,
      revision: null,
      boundProject: null,
    };
    let decision: GrantDecision;
    try {
      decision = await allowedDecision(deps, startRequest);
    } catch (err) {
      return buildRejectedResult(err, undefined, []);
    }

    const notes: string[] = [];
    if (input["approval-policy"] === "on-failure") notes.push(ON_FAILURE_NOTE);
    const approvalPolicy = APPROVAL_POLICY_MAP[input["approval-policy"]];

    let developerInstructions = input["developer-instructions"];
    if (input["compact-prompt"] !== undefined) {
      developerInstructions = developerInstructions
        ? `${developerInstructions}\n\n${input["compact-prompt"]}`
        : input["compact-prompt"];
      notes.push(COMPACT_PROMPT_NOTE);
    }

    let threadId: string | undefined;
    try {
      const started = await turnRunner.startThread({
        cwd,
        model: input.model,
        approvalPolicy,
        sandbox: input.sandbox,
        baseInstructions: input["base-instructions"],
        developerInstructions,
      });
      const startedId = started.threadId;

      // saved before the first turn: a thread that cannot be bound is never used, and its id is
      // not handed back either
      const binding: ThreadBinding = {
        schema: 1,
        threadId: startedId,
        cwd,
        project: decision.project,
        grantId: input.grant ?? null,
        grantRevision: decision.grantRevision,
        expiresAt: decision.expiresAt,
        effectiveHash: decision.effectiveHash,
        approvalPolicy,
        sandbox: input.sandbox,
        ...(input.model !== undefined ? { model: input.model } : {}),
        createdAt: new Date().toISOString(),
      };
      try {
        await deps.bindings.save(binding);
      } catch (err) {
        return buildRejectedResult(new Error(`could not save the thread binding: ${errorMessage(err)}`), undefined, notes);
      }
      threadId = startedId;

      // checked against the thread's actual model (thread/read), since without an explicit
      // `model` the default comes from the codex config, which this server can't see. the thread
      // already exists by then; its id is returned so the caller can reuse it.
      const invalidEffort = await effortError(turnRunner, input.effort, { model: input.model, threadId });
      if (invalidEffort !== undefined) return buildRejectedResult(new Error(invalidEffort), threadId, notes);

      // model went on thread/start above; effort has no thread/start field, so it rides on the
      // first turn/start, where app-server makes it sticky for the rest of the thread.
      const turnResult = await runTurnWithProgress(
        turnRunner,
        threadId,
        input.prompt,
        {
          timeoutMs: input["timeout-seconds"] * 1000,
          effort: input.effort,
          // once the turn has its place in the queue, a resume check on the binding just saved:
          // its project, grant and revision, and the same fingerprint
          beforeStart: async () => {
            await allowedDecision(
              deps,
              {
                phase: "resume",
                harness: "codex",
                cwd,
                addDirs: [],
                grantId: binding.grantId,
                revision: binding.grantRevision,
                boundProject: binding.project,
              },
              binding.effectiveHash,
            );
          },
        },
        extra,
      );
      return buildToolResult(turnResult, notes);
    } catch (err) {
      return buildRejectedResult(err, threadId, notes);
    }
  };

  return {
    name: "codex",
    description:
      "Runs a prompt against Codex over a long-lived `codex app-server` child, starting a new thread. " +
      "Mirrors the removed `codex mcp-server`'s `codex` tool (0.151.0 field set); `profile` is not " +
      "supported (app-server has no equivalent) and `compact-prompt` is folded into " +
      "developer-instructions.",
    inputSchema: codexInputShape,
    handler,
  };
}

// --- `codex-reply` ---------------------------------------------------------------------------

const codexReplyInputSchema = z
  .object({
    threadId: z.string().optional(),
    conversationId: z.string().optional(), // deprecated alias
    prompt: z.string(),
    cwd: z
      .string()
      .optional()
      .describe("Optional. Must be the directory the thread was started in; a different one is refused."),
    model: z
      .string()
      .optional()
      .describe(
        "Switch the thread to this model from this turn on (Codex keeps it for later turns too). " +
          "Omit to keep the thread's current model.",
      ),
    effort: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Reasoning effort for this turn, as a value the model supports (for example low, medium, " +
          "high, xhigh). Codex keeps it for later turns too. Omit to keep the thread's current effort.",
      ),
    "timeout-seconds": z.number().int().positive().default(900),
  })
  .refine((value) => Boolean(value.threadId || value.conversationId), {
    message: "threadId (or the deprecated conversationId) is required",
  });

export function createCodexReplyTool(turnRunner: TurnRunnerLike, deps: BindingDeps): {
  name: string;
  description: string;
  inputSchema: typeof codexReplyInputSchema;
  handler: ToolCallback<typeof codexReplyInputSchema>;
} {
  const handler: ToolCallback<typeof codexReplyInputSchema> = async (input, extra) => {
    // the zod .refine() above guarantees one of these is set before the handler ever runs
    const threadId = (input.threadId ?? input.conversationId) as string;

    try {
      // the thread's project, grant and settings come from its binding, never from the caller
      let binding: ThreadBinding | undefined;
      try {
        binding = await deps.bindings.load(threadId);
      } catch {
        binding = undefined;
      }
      if (!binding) throw new Error(NO_BINDING_TEXT);
      const bound = binding;
      if (input.cwd !== undefined && realPath(input.cwd) !== bound.cwd) {
        throw new Error("cwd differs from the directory this thread was started in. Nothing was sent to Codex.");
      }
      const resumeRequest: GrantRequest = {
        phase: "resume",
        harness: "codex",
        cwd: bound.cwd,
        addDirs: [],
        grantId: bound.grantId,
        revision: bound.grantRevision,
        boundProject: bound.project,
      };
      await allowedDecision(deps, resumeRequest, bound.effectiveHash);

      await turnRunner.ensureThread(threadId, {
        cwd: bound.cwd,
        approvalPolicy: bound.approvalPolicy,
        sandbox: bound.sandbox,
        model: bound.model,
      });
      const invalidEffort = await effortError(turnRunner, input.effort, { model: input.model, threadId });
      if (invalidEffort !== undefined) return buildRejectedResult(new Error(invalidEffort), threadId, []);
      const turnResult = await runTurnWithProgress(
        turnRunner,
        threadId,
        input.prompt,
        {
          timeoutMs: input["timeout-seconds"] * 1000,
          model: input.model,
          effort: input.effort,
          // under the thread's lock: the check again after any queue wait, then the model switch
          // is recorded, so a restart resumes on the model the thread last used
          beforeStart: async () => {
            await allowedDecision(deps, resumeRequest, bound.effectiveHash);
            if (input.model === undefined) return;
            const fresh = await deps.bindings.load(threadId);
            if (!fresh) throw new Error(NO_BINDING_TEXT);
            if (fresh.model !== input.model) await deps.bindings.save({ ...fresh, model: input.model });
          },
        },
        extra,
      );
      return buildToolResult(turnResult, []);
    } catch (err) {
      // unlike `codex`, we always had an id -- it came from the caller, not from startThread --
      // so structuredContent.threadId is always present here, error or not.
      const message = errorMessage(err);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: { threadId, errorText: message },
      };
    }
  };

  return {
    name: "codex-reply",
    description:
      "Continues an existing Codex thread started by `codex` (or a previous session of this server) with a follow-up " +
      "prompt. Mirrors the removed `codex mcp-server`'s `codex-reply` tool; `conversationId` is accepted " +
      "as a deprecated alias for `threadId`.",
    inputSchema: codexReplyInputSchema,
    handler,
  };
}
