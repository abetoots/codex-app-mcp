// zod schemas + handlers for the `codex` / `codex-reply` tools, re-exposing the removed `codex
// mcp-server`'s 0.151.0 field set over a TurnRunner so the multi-model/gauntlet skills need zero
// changes. knows nothing about stdio/child-process wiring -- src/index.ts owns that.
import { z } from "zod";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RunTurnOptions, StartThreadOptions, ThreadSettings, TurnResult } from "./turn-runner.js";

// the subset of TurnRunner's public surface these tools call -- a structural interface (rather
// than importing the TurnRunner class type itself) so src/index.ts's lazy-spawn/respawn wrapper
// (which is not, and cannot cheaply be, an actual TurnRunner instance) can be passed in too.
export interface TurnRunnerLike {
  startThread(options: StartThreadOptions): Promise<{ threadId: string }>;
  ensureThread(threadId: string, fallback: ThreadSettings): Promise<void>;
  runTurn(threadId: string, prompt: string, options?: RunTurnOptions): Promise<TurnResult>;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// how often to send a keepalive notifications/progress while a turn is in flight, when the
// caller asked for one (via _meta.progressToken on the tool call).
const PROGRESS_INTERVAL_MS = 10_000;

const PROFILE_UNSUPPORTED_TEXT =
  "the `profile` field has no equivalent in codex app-server's ThreadStartParams (the thread/start " +
  "request codex-app-mcp sends), so it is not supported here. Drop `profile` from the request " +
  "and use `model` / `config` instead.";

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
    parts.push(isEmptyCompletion(turnResult) ? EMPTY_COMPLETION_TEXT : turnResult.text);
  } else {
    const errorText = turnResult.errorText ?? SYNTHETIC_INTERRUPTED_TEXT;
    parts.push(turnResult.text ? `${turnResult.text}\n\n${errorText}` : errorText);
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}

function buildStructuredContent(turnResult: TurnResult): Record<string, unknown> {
  const structuredContent: Record<string, unknown> = {
    threadId: turnResult.threadId,
    turnId: turnResult.turnId,
    status: turnResult.status,
    declinedRequests: turnResult.declinedRequests,
  };
  if (turnResult.errorText !== undefined) structuredContent.errorText = turnResult.errorText;
  else if (isEmptyCompletion(turnResult)) structuredContent.errorText = EMPTY_COMPLETION_TEXT;
  return structuredContent;
}

function buildToolResult(turnResult: TurnResult, notes: string[]): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: buildContentText(turnResult, notes) }],
    structuredContent: buildStructuredContent(turnResult),
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
  const structuredContent: Record<string, unknown> = { errorText: message };
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
  timeoutMs: number,
  extra: ToolExtra,
): Promise<TurnResult> {
  const progressToken = extra._meta?.progressToken;
  const run = turnRunner.runTurn(threadId, prompt, { timeoutMs });

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

const codexInputShape = {
  prompt: z.string(),
  model: z.string().optional(),
  profile: z.string().optional(),
  cwd: z.string().optional(),
  "approval-policy": z.enum(["untrusted", "on-failure", "on-request", "never"]).default("never"),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
  config: z.record(z.string(), z.unknown()).optional(),
  "base-instructions": z.string().optional(),
  "developer-instructions": z.string().optional(),
  "compact-prompt": z.string().optional(),
  "timeout-seconds": z.number().int().positive().default(900),
};

export function createCodexTool(turnRunner: TurnRunnerLike): {
  name: string;
  description: string;
  inputSchema: typeof codexInputShape;
  handler: ToolCallback<typeof codexInputShape>;
} {
  const handler: ToolCallback<typeof codexInputShape> = async (input, extra) => {
    if (input.profile !== undefined) {
      return { isError: true, content: [{ type: "text", text: PROFILE_UNSUPPORTED_TEXT }] };
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
        cwd: input.cwd,
        model: input.model,
        approvalPolicy,
        sandbox: input.sandbox,
        baseInstructions: input["base-instructions"],
        developerInstructions,
        config: input.config,
      });
      threadId = started.threadId;

      const turnResult = await runTurnWithProgress(
        turnRunner,
        threadId,
        input.prompt,
        input["timeout-seconds"] * 1000,
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
    "timeout-seconds": z.number().int().positive().default(900),
  })
  .refine((value) => Boolean(value.threadId || value.conversationId), {
    message: "threadId (or the deprecated conversationId) is required",
  });

// codex-reply has no cwd/approval-policy/sandbox of its own -- these are the fallback settings
// handed to TurnRunner.ensureThread() when a threadId came from a previous process/session and
// this instance has no remembered settings for it.
const REPLY_FALLBACK_SETTINGS: ThreadSettings = { approvalPolicy: "never", sandbox: "read-only" };

export function createCodexReplyTool(turnRunner: TurnRunnerLike): {
  name: string;
  description: string;
  inputSchema: typeof codexReplyInputSchema;
  handler: ToolCallback<typeof codexReplyInputSchema>;
} {
  const handler: ToolCallback<typeof codexReplyInputSchema> = async (input, extra) => {
    // the zod .refine() above guarantees one of these is set before the handler ever runs
    const threadId = (input.threadId ?? input.conversationId) as string;

    try {
      await turnRunner.ensureThread(threadId, REPLY_FALLBACK_SETTINGS);
      const turnResult = await runTurnWithProgress(
        turnRunner,
        threadId,
        input.prompt,
        input["timeout-seconds"] * 1000,
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
      "Continues an existing Codex thread started by `codex` (or a previous session) with a follow-up " +
      "prompt. Mirrors the removed `codex mcp-server`'s `codex-reply` tool; `conversationId` is accepted " +
      "as a deprecated alias for `threadId`.",
    inputSchema: codexReplyInputSchema,
    handler,
  };
}
