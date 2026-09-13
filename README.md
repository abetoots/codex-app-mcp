# codex-app-mcp

## What this is

`codex mcp-server` was deprecated in codex-cli 0.149.1 and removed in 0.153.0
(PR [#42993](https://github.com/openai/codex/pull/42993)). This is a thin
stdio MCP server that re-exposes the same `codex` / `codex-reply` tool
interface the removed server offered, but drives it by talking to
`codex app-server` — the official (if experimental) JSON-RPC successor
protocol — instead of shelling out per call.

## Requirements

- Node >= 20
- the `codex` CLI on `PATH`, already authenticated (`codex login`, or an API
  key) — auth is not this server's job
- a codex-cli new enough to have `codex app-server` (developed and tested
  against codex-cli 0.154.0)

## Install

```
npm install
npm run build
```

## Register with Claude Code

```
claude mcp add --scope user codex -- node /home/anon/tmp-create-codex-mcp/dist/index.js
```

By default the server spawns `codex` from `PATH`. Set `CODEX_BIN` to point at
a specific binary if the one you want isn't first on `PATH`, e.g.:

```
CODEX_BIN=/path/to/codex claude mcp add --scope user codex -- node /home/anon/tmp-create-codex-mcp/dist/index.js
```

## Tools exposed

Both tools mirror the removed `codex mcp-server`'s 0.151.0 interface, so
existing skills/tooling that call `mcp__codex__codex` /
`mcp__codex__codex-reply` need no changes.

### `codex` — starts a new thread (a persisted codex conversation)

| Param | Values | Default | Note |
|---|---|---|---|
| `prompt` | string | — | required |
| `model` | string | — | optional |
| `cwd` | string | server cwd | optional |
| `approval-policy` | `untrusted \| on-failure \| on-request \| never` | `never` | `on-failure` maps to `on-request` — app-server dropped that value |
| `sandbox` | `read-only \| workspace-write \| danger-full-access` | `read-only` | |
| `config` | object | — | optional |
| `base-instructions` | string | — | optional |
| `developer-instructions` | string | — | optional |
| `compact-prompt` | string | — | folded into `developer-instructions` |
| `timeout-seconds` | number | `900` | |
| `profile` | — | — | rejected outright — app-server has no equivalent field |

### `codex-reply` — continues an existing thread

| Param | Values | Default | Note |
|---|---|---|---|
| `threadId` | string | — | required, or use `conversationId` |
| `conversationId` | string | — | deprecated alias for `threadId` |
| `prompt` | string | — | required |
| `timeout-seconds` | number | `900` | |

### Result shape (both tools)

`content[0].text` is the final answer. `structuredContent` carries
`threadId`, `turnId`, `status`, and `declinedRequests` — the method names of
any app-server approval/permission requests this server auto-declined,
since it runs headless and can't grant filesystem or exec access.

`structuredContent.threadId` is present in every case except one: `codex`
when `thread/start` itself fails, before any thread has ever existed.
There's nothing to report in that case, so no id is synthesized; `codex-reply`
always has one, since its `threadId` comes from the caller, not from a
`thread/start` this server made.

## Testing

- `npm test` runs the full suite (67 tests) against `tests/fake-app-server.mjs`,
  a scripted stand-in for `codex app-server`. Fast, no network, no auth
  needed — this is what CI/every commit should run.
- `bin/smoke.sh` (or `CODEX_LIVE=1 npm run smoke`) runs a real end-to-end
  check against your actual `codex` CLI: starts a thread, gets a reply,
  continues it same-process, then continues it again from a fresh
  `AppServerClient` (simulating a process restart), plus one call through the
  `tools.ts` handler layer. **Run this after every `codex update`** —
  `codex app-server` is an experimental/unstable protocol surface, and this
  is the drift alarm that catches it before a skill call does.

## Fallback note

If `codex app-server`'s protocol changes enough to make this wrapper costly
to maintain, `0Pinky0/codex-mcp-sidecar`'s `CODEX_MCP_SIDECAR_COMPAT=1`
adapter was evaluated as a fallback (see
`~/.claude/docs/decisions/2026-09-14-codex-leg-transport.md`).

## Architecture

`AppServerClient` (JSON-RPC framing over the child's stdio, request
correlation, notification/server-request dispatch) is wrapped by
`TurnRunner` (thread/turn lifecycle, approval declines, per-thread
serialization, timeouts), which `tools.ts` adapts to the MCP tool contract
(zod schemas, kebab-case field mapping, result shaping). `src/index.ts` wires
these together behind a lazy child spawn that respawns automatically if the
`codex app-server` process ever exits. `schema/` is regenerated from the
installed `codex` CLI before every test run (`pretest`), so any protocol
drift shows up immediately as test failures rather than at runtime.
