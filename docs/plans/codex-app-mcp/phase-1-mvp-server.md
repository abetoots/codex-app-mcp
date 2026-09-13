# Phase 1: codex-app-mcp MVP Implementation Plan


**Status:** Implemented. All 8 tasks landed (see repo git log); amendments below are load-bearing and reflected in `src/`.
> **For Claude:** Use executing-plans or subagent-driven-development to implement this plan task-by-task, after Phase 0 sign-off.

**Goal:** A stdio MCP server that exposes `codex` and `codex-reply` (old names, old schema) by driving one long-lived `codex app-server --stdio` child.
**Architecture:** `AppServerClient` frames newline-delimited JSON-RPC over the child's stdio, correlates ids, dispatches notifications, and answers server→client requests. `TurnRunner` composes `thread/start` | `thread/resume` → `turn/start` and collects `agentMessage` items until `turn/completed`. `tools.ts` maps the two MCP tools onto it and returns `threadId` in every case except one: `codex` when `thread/start` itself fails, since no thread was ever created to report.
**Tech Stack:** TypeScript (ESM, strict), Node ≥ 20, `@modelcontextprotocol/sdk` ^1.30, `zod`, Vitest; no Bun.

---

## Layout

```
/home/anon/tmp-create-codex-mcp
├── package.json            # name: codex-app-mcp, bin: dist/index.js, type: module
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts            # McpServer + StdioServerTransport; lazy child spawn
│   ├── app-server-client.ts# JSON-RPC over child stdio
│   ├── turn-runner.ts      # start/resume thread, run turn, collect result
│   ├── tools.ts            # zod schemas + handlers for codex / codex-reply
│   └── protocol.ts         # the method/notification names we depend on (one place)
├── tests/
│   ├── fake-app-server.mjs # scripted stand-in: replays canned JSON-RPC lines
│   ├── app-server-client.test.ts
│   ├── turn-runner.test.ts
│   ├── tools.test.ts
│   └── live.smoke.test.ts  # runs only when CODEX_LIVE=1
├── bin/smoke.sh            # post-`codex update` check (calls the live test)
├── schema/                 # `codex app-server generate-json-schema --out schema` (regenerated, committed)
└── docs/
```

## Tool contract (mirrors the removed `codex_tool_config.rs`)

```ts
// src/tools.ts
export const CodexInput = z.object({
  prompt: z.string().describe("Initial user prompt for the Codex thread"),
  model: z.string().optional(),
  profile: z.string().optional(),
  cwd: z.string().optional().describe("Absolute working directory; defaults to the server's cwd"),
  // schema on 0.154.0: AskForApproval = "untrusted" | "on-request" | "never" | {granular…}; the old
  // "on-failure" value is gone — accept it for backward compatibility and map it to "on-request".
  "approval-policy": z.enum(["untrusted", "on-failure", "on-request", "never"]).default("never"),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
  config: z.record(z.unknown()).optional().describe("config.toml overrides, dotted keys"),
  "base-instructions": z.string().optional(),
  "timeout-seconds": z.number().int().positive().default(900),
});
export const CodexReplyInput = z.object({
  threadId: z.string().optional(),
  conversationId: z.string().optional(), // legacy alias, one of the two is required
  prompt: z.string(),
  "timeout-seconds": z.number().int().positive().default(900),
}).refine(v => v.threadId || v.conversationId, { message: "threadId required" });
```

Result shape (both tools): `content: [{type:"text", text: <final agent message>}]` and
`structuredContent: { threadId, turnId, status: "completed"|"failed"|"interrupted", declinedRequests: string[], usage? }`. On `status:"failed"` also set `isError: true` and put the app-server `error` text in `content`.

Protocol mapping (from local probes on 0.154.0, `docs/research/…` L2–L5):

| Tool step | app-server |
|---|---|
| new thread | `thread/start { cwd, model?, approvalPolicy, sandbox, baseInstructions?, developerInstructions?, config? }` → `result.thread.id`. `sandbox` is a `SandboxMode` string (`read-only` / `workspace-write` / `danger-full-access`) here, verified in `schema/ClientRequest.json` |
| unknown thread after restart | `thread/resume { threadId, cwd, approvalPolicy, sandbox, config? }` (same field shapes as `thread/start`) |
| run | `turn/start { threadId, input:[{type:"text", text}] }` → `result.turn.id`. Per-turn overrides use `sandboxPolicy: {type:"readOnly"|"workspaceWrite"|"dangerFullAccess"|"externalSandbox"}` (an object, unlike thread-level `sandbox`) — we set policy at thread level and leave this unset |
| collect | `item/completed` where `item.type === "agentMessage"` → append `item.text`; stop on `turn/completed` for that `turnId` |
| errors | `error` notification, or `turn/completed` with non-completed status |
| server→client | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `execCommandApproval`, `applyPatchApproval` → respond `{decision:"decline"}` and record; `item/tool/requestUserInput` → respond empty answers and record |
| keepalive | send MCP progress notification every 10 s while a turn runs, when the call carried a `progressToken` |

---

### Task 1: Scaffold
**Status:** Pending
**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`; `git init`.
**Step 1:** `npm init -y`, `npm i @modelcontextprotocol/sdk zod`, `npm i -D typescript vitest @types/node`; scripts `build`, `test`, `smoke`.
**Step 2:** `npx vitest run` → "no test files" exits 0; `npx tsc --noEmit` passes on an empty `src/index.ts`.
**Step 3:** commit `chore: scaffold codex-app-mcp`.

### Task 2: `protocol.ts` + fake app-server
**Files:** Create `src/protocol.ts`, `tests/fake-app-server.mjs`.
**Step 1 (test):** `tests/protocol.test.ts` asserts every name in `protocol.ts` appears in `schema/ClientRequest.json` / `ServerNotification.json` / `ServerRequest.json` (regenerate schema in `pretest`). This is the drift alarm.
**Step 2:** run → FAIL (no schema/protocol yet). **Step 3:** add `codex app-server generate-json-schema --out schema` to `pretest`; write `protocol.ts` with `initialize`, `initialized`, `thread/start`, `thread/resume`, `turn/start`, `turn/completed`, `item/completed`, `error`, and the five approval request names. **Step 4:** PASS. **Step 5:** commit.
Fake server: reads JSON lines on stdin, replies from a scenario file passed via `FAKE_SCENARIO` (initialize → result; thread/start → thread id + `thread/started`; turn/start → `turn/started`, `item/completed` agentMessage "pong", `turn/completed`). Scenarios: `happy`, `approval-request`, `failed-turn`, `exit-mid-turn`.

### Task 3: `AppServerClient`
**Files:** Create `src/app-server-client.ts`, `tests/app-server-client.test.ts`.
**Tests (each RED → GREEN → commit):**
- `request()` resolves with the matching `id` result and rejects on `error`.
- notifications reach `on(method, handler)`; unknown methods are ignored.
- server→client requests (message with `id` + `method`) invoke `onServerRequest` and its return value is written back with the same `id`.
- child exit rejects all pending requests with `AppServerExited` and emits `exited`.
- `initialize` handshake is sent once, `initialized` follows, and requests before the handshake queue.
**Implementation notes:** `spawn(process.env.CODEX_BIN ?? "codex", ["app-server", "--stdio"], { stdio: ["pipe","pipe","pipe"] })`; split stdout on `\n`; stderr → our stderr with a `[app-server]` prefix; never write to our stdout (MCP transport).

### Task 4: `TurnRunner`
**Files:** Create `src/turn-runner.ts`, `tests/turn-runner.test.ts`.
**Tests:**
- happy: `runTurn({threadId})` returns `{ text:"pong", status:"completed", turnId }`.
- two `agentMessage` items concatenate with a blank line.
- `approval-request` scenario: declined, recorded in `declinedRequests`, turn still completes.
- `failed-turn`: status `failed`, error text captured.
- timeout: `turn/interrupt` sent, rejects with `TurnTimeout`.
- `startThread` maps `approval-policy`/`sandbox` kebab-case to app-server `approvalPolicy`/`sandbox` values and passes `cwd`.
- `ensureThread(id)` calls `thread/resume` when the id is not in the known set.

### Task 5: Tools + entry
**Files:** Create `src/tools.ts`, `src/index.ts`, `tests/tools.test.ts`.
**Tests:** schema accepts the old param names and defaults (`never`, `read-only`); `codex` result carries `structuredContent.threadId` except when `thread/start` itself fails (no thread was ever created, so there's nothing to report); `codex-reply` accepts `conversationId` alias; `isError` on failed status; lazy spawn happens on first call, and a second call after a simulated child exit respawns.
**Entry:** `McpServer({name:"codex-app-mcp", version})`, `registerTool("codex", …)`, `registerTool("codex-reply", …)`, `StdioServerTransport`. Progress notifications via `extra.sendNotification` when `_meta.progressToken` present.

### Task 6: Live smoke + `bin/smoke.sh`
**Files:** Create `tests/live.smoke.test.ts` (skipped unless `CODEX_LIVE=1`), `bin/smoke.sh`, `README.md`.
**Test:** `codex` with prompt "Reply with exactly: pong" → text `pong`, threadId present; `codex-reply` "What did you just say?" on that thread mentions `pong`. Budget: < 60 s.
**smoke.sh:** `CODEX_LIVE=1 npx vitest run tests/live.smoke.test.ts`; exit non-zero on failure. Document "run after `codex update`".

### Task 7: Register in Claude Code (start of Phase 2)
```bash
npm run build
claude mcp remove codex -s user
claude mcp add --scope user codex -- node /home/anon/tmp-create-codex-mcp/dist/index.js
claude mcp list   # expect: codex … ✔ Connected
```
Then, in a fresh Claude session: call `mcp__codex__codex` with the pong prompt, then `mcp__codex__codex-reply`; append the ledger rows.

## Verification checklist before claiming done
- `npx vitest run` green; `npx tsc --noEmit` clean.
- `bin/smoke.sh` green against codex-cli 0.154.0.
- `claude mcp list` shows codex connected; both tools called successfully from Claude Code.
- Hub `mcp-servers.yaml` reason updated; `bin/doctor` mentions the smoke test.

---

## Panel amendments (2026-09-14, from `~/.claude/docs/decisions/2026-09-14-codex-leg-transport.md`)

These override anything above that conflicts.

1. **Compatibility baseline is 0.151.0, not 0.50.0.** `codex` fields: `prompt`, `model`, `cwd`, `approval-policy`, `sandbox`, `config`, `base-instructions`, `developer-instructions`, `compact-prompt` (all kebab-case). `profile` is **rejected** with an explicit error (no `ThreadStartParams.profile` exists). `codex-reply` fields: `threadId` (camelCase), `conversationId` (deprecated alias), `prompt`. Result: text content plus `structuredContent: { threadId, ... }` and `isError` on failure, matching `create_call_tool_result_with_thread_id` in the removed server.
2. **`approval-policy` mapping:** `never`→`never`, `on-request`→`on-request`, `untrusted`→`untrusted`, `on-failure`→`on-request` (value removed upstream; note the substitution in the result text).
3. **Server→client requests — method-specific responses, never a blanket `decline`:**
   | Request | Response |
   |---|---|
   | `item/commandExecution/requestApproval` | `{decision:"decline"}` |
   | `item/fileChange/requestApproval` | `{decision:"decline"}` |
   | `item/permissions/requestApproval` | `{permissions:{fileSystem:null,network:null}}` (empty `GrantedPermissionProfile`; verify exact minimal shape against `PermissionsRequestApprovalResponse.json`) |
   | `execCommandApproval`, `applyPatchApproval` (legacy) | `{decision:"denied"}` (`ReviewDecision`) |
   | `item/tool/requestUserInput` | empty answers per `ToolRequestUserInputResponse.json` |
   | `mcpServer/elicitation/request` | decline per `McpServerElicitationRequestResponse.json` |
   | `item/tool/call` (dynamic tool) | JSON-RPC error `-32601` |
   | `account/chatgptAuthTokens/refresh`, `attestation/generate`, anything else | JSON-RPC error `-32601 Method not found` |
   Every declined/errored request is appended to `structuredContent.declinedRequests`.
4. **Turn lifecycle:** register notification handlers before sending `turn/start`; correlate by `threadId` + `turnId`; reject the turn promise if `turn/start` itself returns a JSON-RPC error; on child exit fail every in-flight turn, remove listeners, clear the known-thread set, bump a child generation counter; serialize calls per thread (one in-flight turn per `threadId`); do not treat every `error` notification as terminal (respect `willRetry:true`).
5. **`thread/resume`:** always send `threadId`, `approvalPolicy`, `sandbox` (and `cwd` when known). Values come from the in-process per-thread settings map when present, else from the tool defaults (`never`, `read-only`). Add `tests/turn-runner.test.ts` case "resume across child restart" and a live case in `live.smoke.test.ts`.
6. **Final-answer selection:** the tool text is the last `agentMessage` item whose `phase === "final_answer"`; if none, concatenate all `agentMessage` items. (Observed on 0.154.0: `item.phase` is `"final_answer"` on the reply.)
7. **Fixtures, not names:** `tests/protocol.test.ts` validates full request/response fixtures against the regenerated schema, including `ClientNotification.json` for `initialized`; add `turn/interrupt` to `protocol.ts`.
8. **Timeouts (verified in Claude Code docs 2026-09-14):** `MCP_TOOL_TIMEOUT` default ≈ 28 h; stdio idle timeout default 30 min, reset by progress notifications; calls > 2 min auto-background. Keep the 10 s progress notification and the per-call `timeout-seconds` (send `turn/interrupt` on expiry); no `.mcp.json` `timeout` needed.
9. **Secrets:** Phase 2 must confirm `mcpServer/startupStatus/updated` reports `firecrawl` `ready` when launched by Claude Code; if not, add `${FIRECRAWL_API_KEY}` references to the `env` block of the `codex` entry in `~/.claude.json`.
10. **Fallback:** if app-server churn or a mandatory server request blocks headless turns, test `0Pinky0/codex-mcp-sidecar` (`CODEX_MCP_SIDECAR_COMPAT=1`) against the same fixtures before writing more code.
