# Gauntlet triage (3 of 4 legs in: code-reviewer, test-quality-assessor, Antigravity)

## Confirmed HIGH — fix required (converged independently across all 3 legs so far)

**`item/completed`/`turn/completed` listeners correlate by `threadId` only, not `turnId`.**
`src/turn-runner.ts` `extractAgentMessage`/`extractCompletedTurn` (lines ~60-72) and their
registration in `runTurnOnce` (~169-194). On timeout, `runTurnOnce` synthesizes an
`interrupted` result and unblocks the per-thread lock via fire-and-forget `turn/interrupt`,
without confirming the real app-server turn has stopped. A subsequent `runTurn` on the same
`threadId` registers fresh listeners that will accept a late `item/completed`/`turn/completed`
belonging to the *previous, still-running* turn, since nothing checks `turnId`. Contradicts
Panel amendment #4 in `phase-1-mvp-server.md` ("correlate by threadId + turnId") directly.
**Fix:** capture `turnId` from the `turn/start` response and have both extractors reject any
event whose `turnId` doesn't match the current call's.

## MEDIUM — fix (test-quality-assessor)

1. No test exercises `src/index.ts`'s actual MCP stdio surface (`McpServer` +
   `StdioServerTransport` + zod defaults) — everything tests `tools.ts` functions directly.
   `tests/index.test.ts`'s comment blaming this on Task 7's live smoke test is wrong; that
   test also bypasses the stdio layer. Add a real stdio E2E test (spawn the built entry
   point, real `StdioClientTransport`, `initialize`→`tools/list`→`tools/call`).
2. `ensureThread` has no per-thread-id lock (unlike `runTurn`'s `threadLocks`) — two racing
   `codex-reply` calls on a brand-new thread id could both fire `thread/resume`. Untested in
   either direction; the fake server's `resume` scenario has dead detection code for this.
3. A failing `thread/resume` (as opposed to a failing `turn/start` after a successful resume)
   has no fake-server scenario or test.

## LOW — fix (cheap, worth doing before sign-off)

4. Tautological assertion in the approval-table test (`toBeDefined()` on a static import
   proves nothing about runtime behavior) — `tests/turn-runner.test.ts` ~line 109-123.
5. `protocol.test.ts` only checks protocol.ts names ⊆ schema, never the reverse (a new
   schema-declared `ServerRequest` variant wouldn't fail the "drift alarm" test, even though
   `AppServerClient`'s blanket `-32601` makes it safe-by-construction regardless).

## LOW — documentation fix, not code (both legs agree this is correct behavior, badly worded)

6. `structuredContent.threadId` absent when `thread/start` itself fails is architecturally
   correct (there is no thread yet) but the plan/README phrase "threadId always present"
   overclaims. Fix the wording in README + plan, don't synthesize a fake id.

## Worth adopting from tokensift (2 of 3 legs independently, for reasons found in codex-app-mcp's own code, not cargo-culting)

7. One bounded retry on a transient RPC error at `thread/start`/`thread/resume`/`turn/start`
   (not on mid-turn `error` notifications, which are already correctly non-terminal via
   `willRetry`). Currently zero retries anywhere at the request level.
8. A stable machine-readable reason code in `structuredContent` for the rejected-result path
   (`spawn_failed | rpc_error | child_exited | timeout`), instead of only free-text
   `errorText` — closes a real gap (#3 above) and helps calling skills branch without
   string-matching.

## Deferred, not fixing now (logged, not silently dropped)

- Output-size cap/truncation on the final answer text before returning as MCP `content`
  (LOW, code-reviewer) — real but speculative until a long reply is actually observed
  hitting `MAX_MCP_OUTPUT_TOKENS`; defer.
- Unbounded growth of `knownThreadIds`/`threadLocks`/`activeDeclines` over a long-lived
  process (LOW) — personal infra, not a 28-hour-uptime production service; defer.
- Signal-vs-exit-code untested child-death path (LOW) — behavior is already
  signal-agnostic by code inspection; defer.
- Live-fire falsifier both legs raised independently: does a real app-server, on receiving
  a `-32601`/decline response to an approval-type server request, ever treat it as fatal to
  the turn rather than "denied, continue"? Neither leg tested this live; the research
  report's L3 finding (no approval requests fire at all under `approval-policy:"never"` +
  `sandbox:"read-only"`, which is the default and what dogfooding used) makes this low
  probability for the default config. Log as an open question in the decision record;
  don't block on empirical reproduction right now.

## Awaiting: Codex leg (4th), writing to docs/reviews/2026-09-14-codex-leg-review.md
