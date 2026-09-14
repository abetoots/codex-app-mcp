# Gauntlet review brief: codex-app-mcp implementation

You are one reviewer on a panel. Analyze only; DO NOT modify, create, or delete any files.

## What this is

`/home/anon/tmp-create-codex-mcp` is a newly built thin stdio MCP server that replaces the
removed `codex mcp-server` subcommand by driving `codex app-server` (OpenAI Codex CLI's
JSON-RPC successor protocol) and re-exposing the legacy `codex` / `codex-reply` tool
contract. Built in 8 TDD tasks this session, now live: `claude mcp list` shows it connected,
and if you are the Codex leg reading this, you are almost certainly running through this
very server (`mcp__codex__codex`) — that is intentional dogfooding, not an error. If this
call itself times out, hangs, mishandles an approval, or returns a malformed result, that
is itself a top-severity finding — say so explicitly rather than working around it.

## Scope of this review

1. **Code + tests, architectural, and spec compliance** against the approved plan.
2. **A comparison against `~/tokensift/`**, an unrelated stdio MCP server (Python) built by
   the same user for a different purpose (read-only token due-diligence over public APIs).
   Read its actual source (`~/tokensift/src/`, `~/tokensift/README.md`,
   `~/tokensift/tests/`) yourself — do not take this brief's summary as ground truth.
   `tokensift` has: a uniform result envelope with a typed `error.type` enum
   (`invalid_input | not_found | rate_limited | upstream_unavailable | upstream_changed`)
   and per-error `advice` written for the model; per-provider rate limiting with bounded
   wait; success/negative caching with different TTLs; one bounded retry on
   429/502/503/504 honoring `Retry-After`; stderr-only logging; `raw` output gated behind
   `verbose=true` with a byte cap and `raw_truncated` flag; and a documented "dual-era"
   handshake test (answers both a legacy and a modern per-request metadata shape over a
   real pipe). Identify which of these patterns `codex-app-mcp` is missing, which ones
   don't apply to it (say why), and whether adopting any would fix a real gap you found
   independently in `codex-app-mcp`'s own code — not adoption for its own sake.

## Read these (absolute paths)

- `/home/anon/.claude/plans/dreamy-cooking-galaxy.md` — the approved plan (spec of record)
- `/home/anon/.claude/docs/decisions/2026-09-14-codex-leg-transport.md` — why this exists
- `/home/anon/tmp-create-codex-mcp/README.md`, `src/*.ts`, `tests/*.test.ts`,
  `tests/fake-app-server.mjs` — the implementation and its tests
- `/home/anon/tmp-create-codex-mcp/docs/plans/codex-app-mcp/phase-1-mvp-server.md` — the
  "Panel amendments" section carries load-bearing corrections (approval response schemas
  per request type, turn lifecycle on child exit, 0.151.0 field set) — check the code
  actually implements every amendment, not just the original task list
- `~/tokensift/` for the comparison above
- `git log --oneline` and `git diff` in `/home/anon/tmp-create-codex-mcp` for the actual
  change (8 commits, `2a0b78a`..`3f16c2a` plus a docs-sync commit)

## Specific things to verify, not just skim

- Every server→client request type app-server can send (`schema/ServerRequest.json`) is
  answered — an unhandled one with an `id` would hang a real turn.
- The plan's reject-vs-resolve conventions (turn/start error → reject; child exit mid-turn
  → reject; normal failed/interrupted turn → resolve) are followed consistently in
  `src/turn-runner.ts` and correctly surfaced as `isError` in `src/tools.ts`.
- `structuredContent.threadId` really is present on every code path Task 6/7 claimed,
  including error paths.
- Per-thread turn serialization actually prevents two concurrent `turn/start` calls on the
  same thread (re-derive this from the code, don't just trust the test's ordering trick).
- Test quality: do the fake-server-based tests assert real behavior (final message content,
  declined-request lists, status values) or just "it didn't throw"? Is anything tested only
  via mocking `AppServerClient` itself rather than a real spawned fake-server process (the
  plan required the latter)?
- Anything overbuilt beyond the plan's scope, or anything the plan required that's missing.

## Verdict protocol (mandatory)

A bare GO / APPROVED / "looks good" is non-responsive. Return concrete blockers, each with
a severity (high / medium / low) and the file/line it applies to, OR an explicit falsifier:
the single most likely thing that, if true, breaks this implementation. You may return both.
State plainly what you actually ran/read vs. answered from memory or skimmed.

## Output format

- Verdict: GO | GO-with-fixes | NO-GO
- Blockers: numbered, severity, file/section
- tokensift comparison: which patterns are missing/inapplicable/worth adopting, and why
- Falsifier: one paragraph
- Provenance: what you ran, read, or tested vs. skimmed
