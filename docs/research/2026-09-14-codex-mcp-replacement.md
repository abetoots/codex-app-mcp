# Research Report: Replacing the removed `codex mcp-server` for the multi-model codex leg

**Date:** 2026-09-14
**Question:** `codex mcp-server` no longer exists in codex-cli 0.154.0, so the `codex` entry in `~/.claude.json` fails to connect and the multi-model / gauntlet codex leg (`mcp__codex__codex`, `mcp__codex__codex-reply`) is down. Should we (A) build a thin MCP server wrapping `codex app-server`, (B) adopt `openai/codex-plugin-cc`, or (C) adopt an existing community wrapper?
**Audience / decision:** the owner of this Claude Code setup; picks the transport that restores the codex leg with the least ongoing carrying cost. Feeds a `/multi-model` sign-off.
**Time horizon:** current state (codex-cli 0.154.0, released 2026-09-09) and the next few releases.
**Passes:** 1 (converged: all three workers and the local probes agree)  |  **Sources consulted:** 24 (16 web, 8 local probes/artifacts)

## Direct Answer

Build the thin MCP server on `codex app-server` (option A), preserving the old `codex` / `codex-reply` tool names and input schema so the multi-model and gauntlet skills need no edits. Do not adopt `codex-plugin-cc` for the leg: it exposes no MCP tools, only slash commands and a subagent that shells out to an internal Node script, so it cannot be called programmatically from a skill [6][7][8]. A community wrapper is the fallback if you want zero code: `@kvokka/codex-mcp` is the only one built on app-server, but it needs Bun, which is not installed [L7][12].

## Comparison of Options

| Criterion | A. Own thin MCP server on `app-server` | B. `openai/codex-plugin-cc` | C1. `@kvokka/codex-mcp` | C2. `@trishchuk/codex-mcp-tool` |
|---|---|---|---|---|
| Exposes MCP tools callable from a skill | Yes, by design (`codex`, `codex-reply`) | **No** — slash commands + `codex-rescue` subagent only [6][7] | Yes: `codex`, `codex_reply`, `codex_session`, `codex_check`, `codex_setup` [L7] | Yes (`ask-codex`-style, sessionId continuation) [13] |
| Transport to Codex | `codex app-server` JSON-RPC over stdio [L2][L3][2] | `codex app-server` via broker + companion script [8] | `codex app-server` [12][L7] | `codex exec` + `codex resume` [13] |
| Multi-turn continuation | Verified locally: same-process `turn/start` and cross-process `thread/resume` both work [L4] | Yes, internal (`resumeThreadId`) [8] | Yes (README) [12] | Yes via `codex resume` [13] |
| Schema-compatible with old `mcp__codex__*` | Yes if we mirror `codex_tool_config.rs` [L8] | No | Close (`codex_reply` vs `codex-reply`) | No |
| Runtime deps | Node 24 (present), `@modelcontextprotocol/sdk` 1.30.0 [L6] | Node ≥18.18, codex CLI [9] | **Bun ≥1.4 (absent)** [L7] | Node ≥18, npx [13] |
| Maintenance signal | Ours; protocol is "experimental, not supported for production" [1] | Last push 2026-07-08, 494 open issues+PRs, changelog stale at 1.0.0 [5][10] | Pushed 2026-09-03, 6 stars, 0 open issues [L9] | Pushed 2026-09-06, 24 stars, 0 open issues [L9] |
| Official status | Uses the official recommended surface [1][2] | Official OpenAI repo [5] | Third party | Third party |
| Effort | ~200–300 lines TS + tests | Install only, then rewrite the skill bindings to a Bash shell-out | Install Bun + plugin; plugin hook confines tools to a subagent [12] | Install only; tool names differ, skills need edits |

## Evidence and Tradeoffs

### What happened and what OpenAI recommends
- `codex mcp-server` was deprecated with a warning in codex-cli 0.149.1 (PR #39657 merged 2026-08-20, changelog 2026-08-24) and removed in PR #42993 merged 2026-09-05; the changelog says the entry point is gone as of 0.153.0 [3][4][5]. The installed 0.154.0 treats `mcp-server` as a prompt and fails with "stdin is not a terminal" [L1].
- The official removal page says: use the Codex app server "for integrations that need authentication, conversation history, approvals, and streamed agent events", and warns that app-server "is experimental and isn't supported for production workloads" [1].
- app-server is explicitly **not** an MCP server: it speaks its own JSON-RPC 2.0 protocol, "like MCP" only in transport shape [2]. So there is no drop-in; something must bridge MCP to it. [fact]
- No open issue asking for `mcp-server` back was found on `openai/codex` [unknown, worker 1].

### Option A: thin MCP server on app-server (recommended)
- Locally verified on 0.154.0: `initialize` → `initialized` → `thread/start {cwd, approvalPolicy:"never", sandbox:"read-only"}` → `turn/start {threadId, input:[{type:"text",text}]}` → notifications `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed` (item.type `agentMessage`, `.text` holds the reply), `turn/completed` [L2][L3]. A read-only turn produced no approval requests [L3].
- Continuation verified: a second `turn/start` on the same thread recalled earlier context; a fresh process could `thread/resume` the thread id and continue [L4].
- The full protocol schema can be generated offline with `codex app-server generate-json-schema --out DIR`; it lists 99 client requests, 81 server notifications and 10 server→client requests (approvals, `item/tool/call`, `item/tool/requestUserInput`) [L5]. `codex-plugin-cc` uses the sibling `generate-ts` in its build [11], so pinning to the installed CLI's schema is the pattern OpenAI itself uses. [inference]
- The old tool schema to mirror (from `codex_tool_config.rs`): at rust-v0.50.0 `codex` took `prompt`, `model`, `profile`, `cwd`, `approval-policy`, `sandbox`, `config`, `base-instructions` [L8]; the last pre-removal tag rust-v0.151.0 drops `profile` and adds `developer-instructions` and `compact-prompt`, and `codex-reply` takes camelCase `threadId` (with `conversationId` deprecated) plus `prompt`, returning `structuredContent.threadId` [L12][14]. Mirror 0.151.0. A long-standing bug was the conversation id missing from the `codex` result (issues #8580, #5660, #3712, #8388), so the replacement must always return `threadId` [14].
- Tradeoff: the protocol is experimental and can churn; mitigations are the offline schema generation and a smoke test that runs on `codex update`.

### Alternative base for A: `@openai/codex-sdk`
- The official TypeScript SDK (0.154.0, published 2026-09-11) spawns `codex exec --experimental-json` and parses JSONL; it offers `startThread`, `resumeThread`, `run`, `runStreamed` [L6][15]. The flag still works on 0.154.0 [L10].
- Simpler than raw JSON-RPC, but one process per turn and no `turn/interrupt` or `turn/steer`. (Correction after panel review: the 16,310 input tokens observed for a one-word prompt [L10] are Codex's own system prompt and tool definitions, which an app-server turn also pays; they are not transport overhead.) [inference] Use it only if app-server protocol churn becomes a recurring cost.

### Option B: `openai/codex-plugin-cc`
- Official (openai org, Apache-2.0, created 2026-03-30), 33.1k stars, last push 2026-07-08 [5]. Installs via `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex` [6].
- Exposes `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup` and one subagent; there is **no `.mcp.json` and no MCP server** in the repo tree [6][7].
- Under the hood it spawns `codex app-server` behind a persistent broker and a companion script; the sanctioned entry point is `node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs task "..."` from Bash [8]. Reusing that from the multi-model skill would couple the leg to an undocumented internal path.
- Open bugs relevant to unattended use: lost error message on turn failure (#757), `thread/resume` ignores sandbox policy while the thread is live (#740), SessionEnd hook kills a PID without verifying it is the broker (#743) [10].
- Verdict: fine as an interactive extra, unfit as the programmatic leg. [inference]

### Option C: community wrappers
- `@kvokka/codex-mcp` 3.1.0 (2026-09-03): built on app-server, registers `codex`, `codex_reply`, `codex_session`, `codex_check`, `codex_setup`; ships a Claude Code plugin whose hook "keeps the Codex tools inside that subagent"; requires Bun ≥1.4 [12][L7]. Bun is not installed [L7].
- `@trishchuk/codex-mcp-tool` 2.5.0 (2026-09-06): `codex exec` plus native `codex resume`; different tool names [13].
- `@anhnguyen0905/codex-mcp` 0.27.0: a plan→execute→review workflow plugin, heavier than a leg [16].
- Worker 3's inference that "no community wrapper uses app-server" is contradicted by the kvokka package contents [L7]; the local evidence wins.
- Correction after panel review (Codex leg, verified by the lead with `gh api` and raw READMEs on 2026-09-14): three more app-server-based wrappers exist — `j-pollack/codex-app-server-mcp` (Node ≥24, MCP SDK 1.30, agent-pool tools, 0 stars, created 2026-08-31), `0Pinky0/codex-mcp-sidecar` (Node ≥20, opt-in `codex`/`codex-reply` compat adapter via `CODEX_MCP_SIDECAR_COMPAT=1`, `never`-only approvals, 0 stars, pushed 2026-08-31), and `zai-one/codex-mcp` (Python, job/goal machinery, 1 star, pushed 2026-09-09). None is a maintained drop-in; the sidecar is the named fallback.

## Risks, Unknowns, and Assumptions
- app-server is labelled experimental; method names or params may change between codex releases [1]. Mitigation: pin behaviour to the generated schema and add a smoke test.
- Assumed the leg only needs read-only analysis turns (`approvalPolicy:"never"`, `sandbox:"read-only"`). If a future task needs writes, the server must answer `item/commandExecution/requestApproval` and friends [L5][2].
- The 2026-09-13 ledger row shows a prior session already ran the codex leg as a `codex exec` subprocess with the note "codex mcp down" [L11]; that path is a stopgap, not a fix.
- Whether the MCP startup of nine downstream servers per thread (observed in `mcpServer/startupStatus/updated`) adds latency worth suppressing via config override is untested [L2].

## Confidence Assessment

| Claim | Confidence | Basis |
|---|---|---|
| `mcp-server` is gone and app-server is the official successor | High | official docs, two merged PRs, changelog, local failure [1][3][4][5][L1] |
| app-server start/turn/continue works non-interactively on 0.154.0 | High | three local end-to-end probes [L2][L3][L4] |
| `codex-plugin-cc` exposes no MCP tools | High | full repo tree enumeration + DeepWiki corroboration [6][7] |
| `@kvokka/codex-mcp` is the only app-server-based community wrapper | Medium | npm search + package contents; other packages not all inspected [L7][12] |
| Old tool schema field names | High | source file at rust-v0.50.0 [L8] |

## Open Questions / Caveats
- Did not fetch `codex-plugin-cc`'s `schemas/` directory, which may define a structured output contract; irrelevant once B is rejected for the leg.
- The OpenAI Developer Community announcement author's affiliation is unverified; official status rests on the `openai` org ownership.
- `pal` MCP also failed to connect this session; that is a separate `uvx`-based server and out of scope here.
- Sources not checked: `@ask-llm/codex-mcp` (empty npm README), `@minhspark/codex-mcp-bridge`, `@cexll/codex-mcp-server`.

## Recommended Next Steps
1. Build `codex-app-mcp` (working name) in this directory: Node + `@modelcontextprotocol/sdk`, stdio, tools `codex` and `codex-reply` with the old schema, always returning `threadId`; defaults `approval-policy:never`, `sandbox:read-only`.
2. Point `~/.claude.json` `mcpServers.codex` at it; record the decision in the hub's `mcp-servers.yaml` `orchestrator_only.codex` reason.
3. Add a smoke test that does initialize → thread/start → turn/start → turn/completed, to run after every `codex update`.
4. Get `/multi-model` sign-off before building (this report is the brief).

## Sources
1. [Codex MCP server removal](https://learn.chatgpt.com/docs/mcp-server) — undated, fetched 2026-09-14 — removal notice, app-server recommendation, experimental warning
2. [Codex App Server](https://learn.chatgpt.com/docs/app-server) — fetched 2026-09-14 — protocol overview, handshake, thread/turn methods, approval and sandbox params
3. [PR #39657 Warn when launching the deprecated MCP server](https://github.com/openai/codex/pull/39657) — merged 2026-08-20
4. [PR #42993 Remove the deprecated codex mcp-server command](https://github.com/openai/codex/pull/42993) — merged 2026-09-05
5. [ChatGPT & Codex changelog](https://learn.chatgpt.com/docs/changelog) — entries 2026-08-24, 2026-09-03 (0.153.0), 2026-09-05, 2026-09-09 (0.154.0); plus `gh api repos/openai/codex-plugin-cc` on 2026-09-14 (pushed 2026-07-08, 33,104 stars, 494 open issues+PRs)
6. [openai/codex-plugin-cc README](https://github.com/openai/codex-plugin-cc/blob/main/README.md) — install steps, command list, "wraps the Codex app server"
7. codex-plugin-cc repo tree via GitHub contents API (root, `plugins/codex/*`) — no `.mcp.json`; `agents/codex-rescue.md`; corroborated by [DeepWiki](https://deepwiki.com/openai/codex-plugin-cc)
8. codex-plugin-cc `scripts/lib/app-server.mjs`, `scripts/app-server-broker.mjs`, `scripts/codex-companion.mjs`, `skills/codex-cli-runtime/SKILL.md` — `spawn("codex",["app-server"])`, broker RPC, `resumeThreadId`, Bash shell-out contract
9. codex-plugin-cc `package.json` — `engines.node >=18.18.0`
10. [codex-plugin-cc issues](https://github.com/openai/codex-plugin-cc/issues) — #757, #743, #740, #741, #750, #744, #721 as of 2026-09-14
11. codex-plugin-cc `package.json` `prebuild`: `codex app-server generate-ts`
12. [@kvokka/codex-mcp README](https://www.npmjs.com/package/@kvokka/codex-mcp) — 3.1.0, 2026-09-03 — "Every session runs on `codex app-server`", Bun ≥1.4, Claude plugin + hook
13. [@trishchuk/codex-mcp-tool README](https://www.npmjs.com/package/@trishchuk/codex-mcp-tool) — 2.5.0, 2026-09-06 — `codex exec`, native resume, sessionId
14. openai/codex issues #8580, #5660, #3712, #4651, #8388 — conversationId missing from `codex` tool result
15. [@openai/codex-sdk README](https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md) — startThread/resumeThread/run/runStreamed; spawns the CLI and exchanges JSONL
16. [@anhnguyen0905/codex-mcp README](https://www.npmjs.com/package/@anhnguyen0905/codex-mcp) — 0.27.0, 2026-09-10 — plan→execute→review plugin
17. [From codex mcp-server to App Server and Codex Plugin (danielvaughan.com)](https://codex.danielvaughan.com/2026/08/25/codex-mcp-server-deprecated-app-server-migration-claude-code-plugin-v0149/) — 2026-08-25 — v0.149.1 deprecation, migration narrative (secondary)

Local evidence (this machine, 2026-09-14, codex-cli 0.154.0):
- L1. `codex mcp-server` → "Error: stdin is not a terminal"; `codex --help` lists no `mcp-server`.
- L2. `probe.py`: `initialize` → result; `model/list` → gpt-6-astra, gpt-5.6-sol; `thread/start` → thread id; `mcpServer/startupStatus/updated` for 9 servers.
- L3. `turn.py`: read-only turn completed; `item/completed` carried `agentMessage.text = "pong"`; no approval request.
- L4. `multi.py`: same-thread second turn recalled "zebra"; new process `thread/resume` + turn recalled "zebra".
- L5. `codex app-server generate-json-schema --out schema`: 99 ClientRequest, 81 ServerNotification, 10 ServerRequest methods.
- L6. `npm view`: `@openai/codex-sdk` 0.154.0 (2026-09-11), `@modelcontextprotocol/sdk` 1.30.0; Node v24.14.1, npm 11.11.0.
- L7. `@kvokka/codex-mcp` tarball: `registerTool("codex"|"codex_check"|"codex_reply"|"codex_session"|"codex_setup")`, `dist/app-server/*`, `engines.bun >=1.4.0`; `which bun` → not found.
- L8. `codex-rs/mcp-server/src/codex_tool_config.rs` at tag rust-v0.50.0 — `CodexToolCallParam` fields.
- L9. `gh api` on 2026-09-14: kvokka/codex-mcp pushed 2026-09-03 (6 stars, 0 issues); x51xxx/codex-mcp-tool pushed 2026-09-06 (24 stars, 0 issues).
- L10. `codex exec --experimental-json` and `--json` both emit `thread.started/turn.started/item.completed/turn.completed` JSONL; usage 16,310 input tokens for a one-word prompt.
- L11. `~/.claude/state/multi-model-ledger.jsonl`: 490 codex rows; 2026-09-13 row note "ran as codex exec subprocess (codex mcp down)".
- L12. `codex-rs/mcp-server/src/codex_tool_config.rs` and `codex_tool_runner.rs` at tag rust-v0.151.0 — field list above; `create_call_tool_result_with_thread_id` puts `threadId` in `structured_content`.
- L13. Claude Code docs `env-vars.md` / `mcp.md` fetched 2026-09-14: `MCP_TOOL_TIMEOUT` default 100000000 ms; stdio idle timeout default 1800000 ms reset by progress notifications; `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` default 120000; `MAX_MCP_OUTPUT_TOKENS` default 25000.
