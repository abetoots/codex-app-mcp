# Codex re-review — 2026-09-14

Reviewed baseline: `11e184a`, including the seven specified commits. Overall verdict: **NO-GO**.

## Per-fix verdicts

- `64870dd` — **partially**: both extractors reject another turn’s ID, but the new guards discard genuine notifications processed before the response promise’s continuation assigns the current ID, introducing a completion-loss regression.
- `fa7bce9` — **yes**: `ensureThread` installs a shared promise before yielding, joins concurrent calls for the same ID, records success only after resume succeeds, and removes the pending entry in `finally` on success or failure.
- `c46377a` — **yes**: the new spawned-fake scenario rejects `thread/resume` itself, and the tool test checks `isError`, the caller’s thread ID, and the actual RPC error in both structured content and text.
- `99ac0c9` — **yes**: all seven approval-table cases now compare the response actually received and echoed by the fake process with the fixture and require no RPC error, replacing the static existence assertion.
- `7af438a` — **yes**: the new reverse inclusion check walks generated JSON Schema ServerRequest method variants and requires each in `SERVER_REQUESTS`, complementing the existing forward check.
- `7b97aaf` — **partially**: README and plan correctly exempt failed thread creation, but their replacement “every case except one” claim still contradicts the explicit `profile` rejection path, which returns no structured content before attempting creation.
- `11e184a` — **yes**: the new suite builds and spawns the real entry point, uses the real SDK stdio client for initialization/list/call, and checks advertised defaults and wire results, although the raw-stream test has the defects below and execution could not be completed under the file restriction.

## New findings

1. **HIGH — lost genuine completion after the correlation fix.** `src/turn-runner.ts:71`, `:80`, `:198`, and `:240`; interaction with `AppServerClient.onStdoutData` and `settlePending` in `src/app-server-client.ts`.

   A single stdout chunk can contain, in order, the `turn/start` response, that turn’s `item/completed`, and its `turn/completed`. The client parses every line synchronously. Resolving the pending request schedules `.then`, but does not execute it inside that parsing loop. Both notifications therefore reach TurnRunner while its local `turnId` is still undefined; the new equality guards discard them. Only afterward does `.then` assign the ID and start the timer. A completed turn becomes an empty interrupted result after the timeout (900 seconds by default). Response-before-notification ordering on the wire does not establish promise-continuation-before-notification ordering in this implementation. Losing just the item can also produce a completed result with missing answer text if completion arrives later.

   **Executed falsifier:** loaded current TypeScript source in memory using Node module hooks and `stripTypeScriptTypes`, used the actual AppServerClient request, framing, settlement, and dispatch methods with a synthetic child-stdin sink, and injected the three newline-delimited frames as one Buffer through `onStdoutData`. No fixture or source file was modified. With a 50 ms timeout, observed:

   ```json
   {"threadId":"t","turnId":"u","status":"interrupted","text":"","declinedRequests":[]}
   ```

   An in-memory comparison removing only the two new equality guards returned `status:"completed"` and `text:"valid-answer"` for the same frames. This is a deterministic parser-level reproduction, not a live app-server reproduction. The first successful current-source probe ran before the concurrent debug edits described below.

   Preserve correlation while buffering relevant notifications until the start response ID is available, then replay only matching events, or provide equivalent ordering at the dispatch boundary. Add a deterministic same-chunk regression case; do not rely on separate writes arriving as separate chunks. Ensure replay and timer setup cannot leave a timer active after settlement.

2. **MEDIUM — the stale-event regression test does not independently prove item rejection.** `tests/turn-runner.test.ts:257`; `tests/fake-app-server.mjs`, committed `stale-turn-after-timeout` scenario.

   The committed scenario does reproduce the original lifecycle: A times out locally; interrupt is acknowledged without A completing; B starts on the same thread; A’s item and completion are then emitted before B’s real answer. The original thread-only completion listener would settle B with A’s ID and answer. Thus this is a meaningful reproduction of premature completion, not merely an unrelated-thread test.

   However, accepting A’s stale final-answer item while correctly rejecting A’s completion would still pass: B’s later `final_answer` replaces A’s text in `selectFinalText`. Add a case in which a leaked stale item changes the observable answer, such as B producing only non-final messages. Also, the scenario’s comment claiming B’s ID is “already known client-side” is not guaranteed by its back-to-back writes; the same-chunk issue in finding 1 applies. Test both pre-ID buffering and post-ID stale-event rejection explicitly. These test weaknesses are established by control-flow inspection, not a persisted test mutation.

3. **LOW — documentation still overstates the thread-ID guarantee.** `README.md:78`; `docs/plans/codex-app-mcp/phase-1-mvp-server.md`, Architecture and Task 5.

   `createCodexTool` returns an error with only `content` when `profile` is supplied. The existing tools test explicitly requires `structuredContent` to be undefined on this path. No `thread/start` is attempted. Initialization/spawn failures also occur before a thread ID is obtained, and schema-validation failures are outside the handler’s result guarantee. Describe the guarantee as applying once an ID has been obtained (or supplied for a valid reply), with pre-creation/validation failures exempt. Keep the no-fabricated-ID behavior. README’s “67 tests” is also stale relative to the review brief’s claimed 75 total cases.

4. **LOW — raw stdio test resends requests and overclaims frame validation.** `tests/stdio.test.ts:139` and `:168`.

   Once response 1 is recorded, every subsequent parsed line triggers another initialized notification and another tools/call with ID 2, including response 2 itself. The test therefore sends an extra tool invocation immediately before resolving and killing the server. Gate that transition once, assert successful response envelopes, and validate JSON-RPC structure if claiming “only valid JSON-RPC frames”: `JSON.parse` alone accepts unrelated JSON logging. The SDK-based list/call tests still close the original transport-coverage gap. Also, the happy fake ignores thread/start settings, so the new tests check advertised defaults and minimal invocation, but do not independently prove the forwarded default policy values.

## Scope and deferred work

The seven commits change production behavior only in turn correlation and resume deduplication. They do not implement an output cap, eviction for the existing long-lived maps/sets, signal-specific child-death testing, automatic request retries, or structured reason codes. `ensureThreadLocks` is a new transient map necessary for the agreed concurrency fix and deletes settled entries; this is not a general map-retention project. Existing active-decline cleanup remains unchanged. The live approval-denial/fatality question remains open; I did not perform live approval experiments.

The README parameter-table rewrite is extra documentation scope, explicitly disclosed in `7b97aaf`’s commit message, and introduces no runtime expansion. The broader requested diff `3f16c2a..11e184a` also includes `c438a06`, the intervening implementation-status documentation commit; it is not one of the seven fixes.

## Overall verdict

**NO-GO.** The HIGH correlation change introduces a reproducible completion-loss regression. The documentation fix is also incomplete. Resolve finding 1, strengthen the stale-item test, and rerun the suite before sign-off. The remaining notes are non-blocking individually.

## Provenance and verification limits

- Read the re-review brief and triage in full, and the original brief for context. Read the specified current files in full: `src/turn-runner.ts`, `tests/turn-runner.test.ts`, `tests/stdio.test.ts`, `tests/tools.test.ts`, `tests/protocol.test.ts`, `tests/fake-app-server.mjs`, README, and the phase-1 plan. Read supporting client, tools, entry, protocol, response-table, package, compiler, Vitest, and schema-generation code. Inspected the aggregate diff, focused diffs, commit history, and seven fix commit descriptions. Re-read sections where combined tool output was truncated. This is the requested fix re-review, not a fresh tokensift comparison or a full re-execution of the historical original brief.
- Ran `npx tsc --noEmit` inside `bwrap --ro-bind / / --dev /dev --proc /proc`: **passed**, exit 0. This typechecks the configured `src` include, not the test sources.
- Ran `npm test` under the same read-only filesystem enforcement: **blocked in pretest**, exit 1, because schema generation attempts to write `schema/ApplyPatchApprovalParams.json`. No Vitest case ran through that command.
- Tried `npx vitest run --configLoader runner --no-cache` under the same enforcement to bypass schema regeneration and avoid a bundled config write: **seven suite-load failures, zero tests executed**, because the runner still attempts to create `/tmp/.../ssr`. The stdio suite’s mandatory `npm run build` would also write `dist`. I did not relax the user’s instruction permitting only the review output file to change. These are execution-environment limitations, not claimed product test failures. **The claimed 73 passed / 2 skipped / 6 passing files + 1 skipped file is not independently confirmed.**
- Ran the successful no-file parser probes described in finding 1. An earlier attempted spawned-inline-child probe exited before yielding a result; it is not evidence for the finding and is not counted as a passed test.
- No browsing or live Codex smoke test was used. No observed hang or malformed response of this review session itself can be attributed to the wrapper. Successful delivery of this output through the enclosing harness cannot be verified from inside the turn.
- Shared-workspace caveat: initial status had only pre-existing untracked review documents. Later, changes appeared in `src/app-server-client.ts` (debug logging), the fake-server scenario, several scratch/log/patch files, and a draft at this output path. They were not created by this review’s commands. I inspected those differences, left all non-output files untouched, and did not adopt the draft’s claims of running or modifying tests. The second in-memory comparison saw the debug logging; the first successful reproduction preceded it. HEAD remained `11e184a`. The scenario analysis above refers to the original committed scenario read before those concurrent changes.
- The only file written by this reviewer is this requested output file; no source fixes, test fixtures, generated artifacts, or scratch files were written.
