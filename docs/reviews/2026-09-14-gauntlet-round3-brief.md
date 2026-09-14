# Gauntlet round 3 (final) re-review brief: codex-app-mcp

You are one reviewer on a panel. Analyze only; DO NOT modify any file except as noted below.

## IMPORTANT: independence requirement

Do NOT read `docs/reviews/2026-09-14-codex-leg-review.md` or
`docs/reviews/2026-09-14-codex-rereview.md` — those are other legs' own prior outputs from
earlier rounds. Round 2's Antigravity leg produced a reply that only pointed at another
leg's file instead of doing independent work, which this panel does not accept as a valid
review. Form your own judgment from the code and tests directly. You may read
`2026-09-14-gauntlet-triage.md` and `2026-09-14-gauntlet-rereview-brief.md` for background on
what was found/fixed in prior rounds — those are fine, they're the shared problem statement,
not another leg's answer.

If you need to reproduce anything live (running code, modifying a scenario file to test a
race, etc.): work in a **copy** under `/tmp` or your own scratch space, never edit any
tracked file in `/home/anon/tmp-create-codex-mcp/src` or `/home/anon/tmp-create-codex-mcp/tests`
directly. Before you finish, run `git status --porcelain` in
`/home/anon/tmp-create-codex-mcp` yourself and confirm it is clean (only the untracked
`docs/reviews/*.md` files are expected) — if it isn't, revert your own changes before
reporting. A prior round left uncommitted reproduction artifacts in the tracked tree and
they had to be manually cleaned up; do not repeat that.

## Context

Round 1 found a HIGH turnId-correlation bug (fixed, commit `64870dd`) plus 6 lower-severity
items (fixed, `fa7bce9`..`11e184a`). Round 2's re-review found that the round-1 fix for the
HIGH finding had a second, subtler bug: `turnId` was captured via a `.then()` microtask
callback, which races synchronous same-chunk notification dispatch and can silently drop a
genuine event. Round 2 also found `tests/stdio.test.ts`'s `beforeAll` running a blocking
build that raced vitest's parallel file execution, causing ~50% spurious test failures.

Both are now fixed:
- `07974b4` — `AppServerClient.request()`/`sendRequest()` gained an additive
  `onSettled` callback invoked synchronously in `settlePending()`, before any Promise
  microtask deferral; `TurnRunner` now sets `turnId` there instead of via `.then()`. New
  fake-server scenario `turn-start-same-chunk-as-event` writes the response and the turn's
  own first notification in a single `process.stdout.write()` call to reproduce the
  original race; it failed (timeout) before the fix and passes after.
- `5c52013` — the build moved into `pretest` (runs once before vitest starts); the
  per-file `beforeAll` build was removed from `stdio.test.ts`.

## Your job

1. Read `src/app-server-client.ts` (the `onSettled` mechanism, `settlePending`,
   `sendRequest`, and the pre-initialize queuing path) and `src/turn-runner.ts`
   (`runTurnOnce`'s use of it) yourself, and independently re-derive whether the
   microtask-ordering gap is actually closed — trace the exact synchronous-vs-microtask
   ordering yourself, don't take the commit message's word for it.
2. Check the `turn-start-same-chunk-as-event` fake-server scenario/test genuinely
   reproduces "same chunk" (or a sufficiently equivalent ordering) rather than a weakened
   version that wouldn't have caught the original bug.
3. Confirm the `stale-turn-after-timeout` test from round 1 still passes and still means
   what it's supposed to (no regression from the `onSettled` refactor).
4. Confirm `package.json`'s `pretest` builds before tests run, `stdio.test.ts` no longer
   does its own build, and run `npm test` yourself **6 times in a row** to independently
   verify the flakiness is actually gone (not just trust the implementer's claimed 6/6).
5. Look for anything new introduced by these 2 fixes specifically (not a full re-review of
   everything — rounds 1-2 already covered the rest; focus here).

## Verdict protocol (mandatory)

State explicitly, for each of the 2 fixes: resolved (yes/partially/no) with your own
reasoning, not a restatement of the commit message. State plainly what you ran vs. read vs.
reasoned about. If you find nothing wrong, say so explicitly with what you checked — do not
just say "looks good."

## Output format

- Fix A (microtask race, `07974b4`) verdict: yes/partially/no + your own mechanism trace
- Fix B (flaky build, `5c52013`) verdict: yes/partially/no + your own 6-run result
- New findings (if any): numbered, severity
- Overall verdict: GO | GO-with-notes | NO-GO
- Provenance: what you ran/read/reasoned about, and confirmation the tree is clean
