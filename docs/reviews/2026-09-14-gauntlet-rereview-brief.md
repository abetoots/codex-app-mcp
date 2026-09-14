# Gauntlet re-review brief: codex-app-mcp fixes

You are one reviewer on a panel. Analyze only; DO NOT modify, create, or delete any files.

## Context

The original gauntlet review (brief at
`/home/anon/tmp-create-codex-mcp/docs/reviews/2026-09-14-gauntlet-brief.md`, still readable
for full context) surfaced findings from four legs (an internal code-reviewer, an internal
test-quality-assessor, Google Antigravity, and OpenAI Codex — Codex's review was lost to a
harness notification quirk and then hit a usage limit on retry, so it never got a first pass
on the *original* code). All findings were triaged in
`/home/anon/tmp-create-codex-mcp/docs/reviews/2026-09-14-gauntlet-triage.md`. Seven fixes
landed, one commit each: `64870dd` `fa7bce9` `c46377a` `99ac0c9` `7af438a` `7b97aaf`
`11e184a` (see `git log --oneline` for the full history; these are the top 7).

## Your job

1. **Read the triage doc** (`2026-09-14-gauntlet-triage.md`) to see what was found and what
   was promised as the fix.
2. **Read the actual diff** for the 7 commits above (`git show <sha>` or `git diff
   3f16c2a..11e184a`) and the current state of `src/turn-runner.ts`, `tests/turn-runner.test.ts`,
   `tests/stdio.test.ts`, `tests/tools.test.ts`, `tests/protocol.test.ts`,
   `tests/fake-app-server.mjs`, `README.md`, `docs/plans/codex-app-mcp/phase-1-mvp-server.md`.
3. **Verify each of the 7 fixes actually resolves the finding it claims to**, not just that
   something changed. In particular, for the HIGH finding (turnId correlation,
   `64870dd`): re-derive from the code whether `extractAgentMessage`/`extractCompletedTurn`
   now genuinely reject a stale turn's late notification, and whether the new
   `stale-turn-after-timeout` fake-server scenario + test actually reproduces the original
   race (not a weaker version of it).
4. **Run the tests yourself** — `npx tsc --noEmit` and `npm test` — and confirm the counts
   match what's claimed (73 passed, 2 skipped, 6 files + 1 skipped file).
5. **Look for anything new the fixes might have introduced** — a regression, a new gap, an
   overcorrection, scope creep beyond what was triaged. The triage doc explicitly deferred
   some items (output-size cap, unbounded map growth, signal-vs-exit-code, the
   tokensift-inspired retry/reason-code ideas) — confirm those were in fact left alone, not
   silently expanded into.
6. If you are the Codex leg: you are almost certainly running through this very server. If
   this call itself misbehaves (hangs, times out, mishandles something), that is itself a
   finding — say so.
   **Write your complete review to a file** so nothing is lost to notification truncation:
   `/home/anon/tmp-create-codex-mcp/docs/reviews/2026-09-14-codex-rereview.md` (use
   `sandbox: workspace-write` scoped to this directory, `approval-policy: never`). Reply in
   chat with just the file path and your one-line verdict.

## Verdict protocol (mandatory)

A bare GO / APPROVED is non-responsive. For each of the 7 fixes, state explicitly whether it
resolves the original finding (yes / partially / no) with your reasoning. Then give an
overall verdict: GO (all resolved, nothing new) | GO-with-notes (resolved, minor new items,
non-blocking) | NO-GO (a fix is incomplete or introduced a new problem). State plainly what
you ran vs. read vs. skimmed.

## Output format

- Per-fix verdict: 7 lines, one per commit, yes/partially/no + one-sentence reason
- New findings (if any): numbered, severity, file/section
- Overall verdict: GO | GO-with-notes | NO-GO
- Provenance: what you ran/read
