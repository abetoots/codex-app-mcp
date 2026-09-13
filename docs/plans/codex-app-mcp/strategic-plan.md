# codex-app-mcp Strategic Plan

**Date:** 2026-09-14 · **Status:** Implemented (8 tasks, TDD, committed `2a0b78a`..`3f16c2a`; live-verified against codex-cli 0.154.0; wired into `~/.claude.json` and `~/ai-cli-sync/mcp-servers.yaml`) · **Research:** `docs/research/2026-09-14-codex-mcp-replacement.md`

## Problem Statement

`codex mcp-server` was removed in codex-cli 0.153.0 (PR #42993, 2026-09-05). The `codex` entry in `~/.claude.json` still runs it, so the MCP server fails to connect and the multi-model / gauntlet codex leg (`mcp__codex__codex`, `mcp__codex__codex-reply`) is dead. OpenAI's successor, `codex app-server`, is a JSON-RPC 2.0 protocol that is explicitly not MCP. Something must bridge MCP to it.

## Constraints

- Technical: codex-cli 0.154.0 with app-server (experimental); Node 24 / npm 11 present, Bun absent; MCP stdio transport as Claude Code consumes it; secrets injected by the `codex()` shell wrapper, not by a global rc.
- Skill compatibility: `multi-model`, `gauntlet`, and 490 ledger rows are bound to the tool names `codex` / `codex-reply` and the old param names (`prompt`, `cwd`, `sandbox`, `approval-policy`, `model`, `config`). Changing them costs skill edits and breaks the ledger's leg continuity.
- Governance: the hub's `mcp-servers.yaml` records `codex` as `orchestrator_only`; whatever replaces it must keep that entry truthful, and the multi-model skill requires a leg with its own tools (assume-parity), so codex's own MCP servers must stay enabled inside the leg.
- Resources: one person, one machine; the leg is used almost daily (ledger), so the fix should land in one session and be restorable by `bin/doctor`.

## Success Criteria

1. `claude mcp list` shows `codex … Connected`, and `mcp__codex__codex` returns Codex's final answer plus a `threadId` for a read-only prompt.
2. `mcp__codex__codex-reply` continues that thread and demonstrably recalls earlier context.
3. A `/multi-model` or `/gauntlet` run logs codex `phase:"call"` rows with no `error_class`.
4. A smoke test exists that can be rerun after `codex update` and fails loudly if the app-server protocol drifted.
5. No edits to `multi-model/SKILL.md` or `gauntlet/SKILL.md` beyond a one-line note about the transport.

## Alternatives

| Approach | Pros | Cons | Complexity | Timeline |
|---|---|---|---|---|
| **A. Own thin MCP server on `codex app-server`** (recommended) | Official successor surface; verified end to end on 0.154.0; keeps old tool names and schema; Node only; full control of approvals, timeouts, result shape | We own it; app-server is labelled experimental, so protocol churn is our maintenance | Low–medium (~300 lines TS + tests) | 1 session |
| A′. Same server on `@openai/codex-sdk` (`codex exec --experimental-json`) | Official SDK, simplest code | One process per turn, ~16k-token prompt overhead per turn, no interrupt/steer, flag literally named experimental | Low | 1 session |
| **B. `openai/codex-plugin-cc`** | Official, popular, zero code | Exposes no MCP tools; skills would have to shell out to an internal, undocumented Node script; last push 2026-07-08; unattended-use bugs (#740 sandbox on resume, #757 lost errors, #743 PID kill) | Low to install, medium to rebind skills | 1 session, but leaves a fragile coupling |
| C1. `@kvokka/codex-mcp` | Built on app-server; near-identical tools (`codex`, `codex_reply`) | Requires Bun (not installed); its plugin hook confines codex tools to a subagent; 6 stars, single maintainer | Low | hours |
| C2. `@trishchuk/codex-mcp-tool` | npx install; `codex exec` + resume | Different tool names and semantics; skills need edits; exec overhead per turn | Low | hours |

**Recommendation:** A. It is the only option that is simultaneously on the official surface, schema-compatible with the existing skills, and free of a new runtime. B is rejected for the leg but remains a fine *interactive* add-on later (`/codex:review`). C1 is the zero-code fallback if the panel judges owning ~300 lines worse than installing Bun.

## Phase Overview

### Phase 0: Decision
**Goal:** `/multi-model` sign-off on approach A versus B/C, with falsifiers recorded.
**Dependencies:** research report.
**Deliverables:** `~/.claude/docs/decisions/2026-09-14-codex-leg-transport.md`; ledger rows.
**Risks:** codex leg is down, so the codex vote runs as a `codex exec` subprocess (precedent: 2026-09-13 ledger row). Mitigation: state that in the decision record.

### Phase 1: MVP server (`codex-app-mcp`)
**Goal:** stdio MCP server exposing `codex` and `codex-reply` over one long-lived `codex app-server --stdio` child.
**Dependencies:** Phase 0 GO.
**Deliverables:** `src/` (client, turn runner, tools, entry), unit tests against a fake app-server, opt-in live smoke test, `bin/smoke.sh`, README.
**Risks:** protocol churn (mitigate: generate schema from the installed CLI into `schema/`, assert the handful of methods we use exist); MCP tool-call timeout in Claude Code on 10-minute reviews (mitigate: MCP progress notifications every ~10 s, per-call `timeout-seconds` param, `MCP_TOOL_TIMEOUT` documented); server→client approval requests when a prompt asks for writes (mitigate: default `approval-policy: never` + `sandbox: read-only`, auto-decline others and report it in the result).

### Phase 2: Wiring and governance
**Goal:** the leg is live and restorable.
**Dependencies:** Phase 1 tests green.
**Deliverables:** `~/.claude.json` `mcpServers.codex` → `node <path>/dist/index.js`; hub `mcp-servers.yaml` `orchestrator_only.codex.reason` updated; `bin/doctor` (hub) check that the smoke test passes; one-line transport note in `multi-model/SKILL.md` and `gauntlet/SKILL.md`; ledger row for the first real call.
**Risks:** env parity — Claude Code launches the server without the `codex()` wrapper's `secrets.env`, so codex's downstream MCP servers (firecrawl) may lack keys. Mitigation: verify with `mcpServer/startupStatus/updated`; if missing, load `secrets.env` names via the hub's existing `${VAR}` reference pattern in `~/.claude.json`.

### Phase 3 (optional, later): richer leg
**Goal:** only if a real task needs it — `workspace-write` with approval bridging to the MCP client (`elicitation`), `turn/interrupt` tool, streaming deltas, and `/codex:review` from `codex-plugin-cc` for interactive use.
**Dependencies:** a ledger row showing the need.

## Dependencies

```
Phase 0: Decision (/multi-model)
    └──► Phase 1: MVP server
            ├──► 1a client + fake app-server tests
            ├──► 1b turn runner
            ├──► 1c tools + entry
            └──► 1d live smoke test
                    └──► Phase 2: wiring + governance
                              └──► Phase 3 (optional)
```

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| app-server protocol changes on `codex update` | leg silently breaks | `bin/smoke.sh` after every update; schema regeneration; pin the four methods and three notifications we depend on in one file |
| OpenAI ships an official MCP surface later | our server becomes redundant | keep the server thin and schema-compatible so swapping it out is a config change |
| Claude Code MCP timeout kills long reviews | low (docs verified 2026-09-14: wall clock ≈ 28 h, stdio idle 30 min reset by progress, auto-background at 2 min) | 10 s progress notifications; `timeout-seconds` param with `turn/interrupt` |
| Thread continuation after child restart | `codex-reply` fails | on unknown threadId, `thread/resume` before `turn/start`; return an explicit error otherwise |
| Downstream MCP startup per thread (9 servers) adds latency | slower first turn | measure; optionally `config: {mcp_servers: {}}` per call for pure-reasoning tasks (never for research tasks, per assume-parity) |
| Usage-limit errors from ChatGPT plan | leg unavailable | surface the `error` notification text verbatim in the tool result so the orchestrator can log `error_class` |
