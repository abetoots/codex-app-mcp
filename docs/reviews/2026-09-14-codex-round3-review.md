# Independent round-3 review

Reviewed the initially clean tracked snapshot at HEAD `5c520130f6486ded3e71a56c58dbbaadf5508657`, focusing on `07974b4` and `5c52013`. Concurrent uncommitted edits appeared at the final status check; the verdict and reproduction results below apply to the original snapshot, not those later edits.

## Fix A (microtask race, `07974b4`): partially resolved

**The specific ordering gap is closed.** However, the callback refactor introduces the exception-handling regression in finding 1.

My mechanism trace:

1. `runTurnOnce` installs item, completion, and exit listeners before requesting `turn/start`. The listeners read the mutable local `turnId` when invoked.
2. `sendRequest` stores the supplied callback in the pending map before writing the request.
3. `onStdoutData` parses newline-delimited messages in a synchronous loop. On a response, `handleMessage` calls `settlePending`, which removes the pending entry and invokes `onSettled` immediately on success.
4. The runner's callback assigns `turnId` and installs its timeout before returning. Only then does `settlePending` resolve the request Promise. Subsequent notification lines in that same parser invocation therefore see the assigned ID. Completion clears the already-installed timeout and removes the listeners.
5. Previously, resolving the request merely scheduled the runner's `.then()` continuation. The parser could dispatch both notifications before that continuation assigned the ID, causing both filters to discard genuine events.
6. The pre-initialize path preserves the fix: its queued closure passes `onSettled` directly to `sendRequest`. The extra `.then(resolve, reject)` forwards the outer Promise settlement but does not defer the hook. Handshake failure rejects queued requests without invoking the hook; RPC errors also bypass the hook and reject normally.

I independently exercised the actual compiled client parser and runner with a synthetic transport, feeding the response, stale notifications, and genuine item/completion notifications in **one Buffer**. The current runner returned `completed` with `same-chunk`; stale events were ignored. A separate queued-request probe confirmed the hook had already run when the item listener executed. Substituting the pre-fix runner from `07974b4^` made the identical single-buffer probe return `interrupted` with empty text. Restoring the current runner restored the passing result.

### Same-chunk scenario and test

Read `tests/fake-app-server.mjs:468` and `tests/turn-runner.test.ts:273`. The scenario assembles response, `turn/started`, `item/completed`, and `turn/completed` as four newline-delimited frames in a single `process.stdout.write`. It does not insert an await, timer, or separate send between those frames. The test requires completed status, ID `u1`, and text `same-chunk`, with a 2-second deadline: losing completion fails by timeout, and losing just the item fails the text assertion.

This is a meaningful reproduction, not a deliberately deferred notification. One qualification: the comment claiming one write *guarantees* one receiving data chunk is stronger than a byte-stream transport guarantees. The fixture does not assert receiver chunk boundaries. My direct single-Buffer negative control removes that uncertainty and independently demonstrates that this ordering catches the original bug. The actual child-process regression test could not pass in this environment; see Fix B.

### Stale-turn regression

Read `tests/fake-app-server.mjs:427` and `tests/turn-runner.test.ts:257`. A receives ID `uA`, times out at 50 ms, and sends an interrupt. The fixture acknowledges the interrupt without completing A, accepts B on the same thread, replies with `uB`, then sends A's stale item and completion before B's genuine events. Assertions require A to be interrupted with `uA`, and B to complete with `uB` and `real-B`.

The ID comparisons remain intact. Synchronous assignment of `uB` before processing subsequent events also makes the fixture's intended ordering hold even if B's response and A's events share a chunk. The test detects premature completion by A; its final-answer selection could mask stale-item accumulation alone if B's later final answer overwrites it, so that portion additionally relies on reading the unchanged item-ID filter.

**I cannot confirm that this integration test still passes:** it failed during initialization in all six runs below, before reaching its scenario. The in-process probe confirms stale-ID rejection alongside same-buffer delivery, but is not a substitute for the complete timeout/interrupt integration test.

## Fix B (flaky build, `5c52013`): partially resolved

**The build-order change is correct; the requested clean six-run verification is not established.** `package.json` runs schema generation followed by `npm run build` in `pretest`, then `vitest run` in `test`. All six logs show that order. A failing generation or build prevents the normal test lifecycle from proceeding. `tests/stdio.test.ts` no longer imports `beforeAll` or `execFileSync` and contains no build invocation. Thus the per-file concurrent compiler responsible for the reported race is removed.

I ran `npm test` six consecutive times, without changing source, tests, or test configuration between runs, in `/tmp/codex-round3-5irGYx`, using copied dependencies. Node was `v24.14.1`; npm was `11.11.0`.

| Run | Exit | Passed | Failed | Skipped | Vitest duration |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 22 | 52 | 2 | 6.97 s |
| 2 | 1 | 22 | 52 | 2 | 6.94 s |
| 3 | 1 | 22 | 52 | 2 | 6.35 s |
| 4 | 1 | 22 | 52 | 2 | 6.35 s |
| 5 | 1 | 22 | 52 | 2 | 7.01 s |
| 6 | 1 | 22 | 52 | 2 | 6.37 s |

Each reported five failed test files, one passed, one skipped, and three unhandled errors. The dominant failure was `AppServerExited: app-server exited (code=0, signal=null)` during handshake; stdio tests reported closed connections or timeout. Schema generation emitted a read-only PATH-alias warning but proceeded through compilation into Vitest.

A minimal independent Node probe spawning `process.execPath` with `['-e', 'console.log(123)']`, piping stdout/stderr and observing exit, likewise produced no child output and exit 0. A direct fake-server spawn behaved similarly. This supports an execution-environment limitation affecting piped children, rather than evidence of the original intermittent build-contention bug. I did not establish the environment's underlying cause. These are six actual failed runs, not six passes, and I do not claim the flakiness is empirically gone.

## New findings

1. **MEDIUM — exceptions in the new synchronous hook escape the stdout handler and strand the request.** Location: `src/app-server-client.ts:250`, with the concrete caller at `src/turn-runner.ts:248`.

   `settlePending` deletes the pending entry, then invokes `pending.onSettled` without catching exceptions. A successful JSON-RPC response containing `result: {}` causes `result.turn.id` to throw. Previously this access ran inside `.then()`, so the subsequent `.catch(fail)` rejected the turn and cleaned up. Now the exception escapes `onStdoutData` through the stdout event listener, potentially terminating the MCP process. If an outer uncaught-exception handler keeps the process alive, neither the request nor the turn settles: the pending map entry is gone and the timeout was never installed. Later lines in that parser invocation are also not processed.

   Reproduced in the scratch copy using the real parser and runner with an outer probe-only catch. Current code reported `Cannot read properties of undefined (reading 'id')`, turn state `pending` after 50 ms, and zero pending-map entries. The pre-fix runner instead reported turn state `rejected` with no escaped exception. Restoring current code reproduced the regression again. The triggering response violates the expected result shape; this is a regression in failure containment, not a failure on valid successful responses.

   Recommended correction: retain synchronous execution but catch hook exceptions and reject the pending request, allowing the runner's existing catch/cleanup path to operate. Add focused coverage for a throwing hook and malformed successful turn-start result, including continued parsing of subsequent frames.

No additional production regression was identified in the two fixes within this review's scope. The same-chunk comment qualification is a test-portability note, not a second production defect.

## Overall verdict: NO-GO

The intended ordering repair is sound and the concurrent per-file build is removed. Approval is withheld because of the reproduced callback exception regression and because the required passing integration evidence, including stale-turn behavior and six clean suite runs, could not be obtained in this environment.

## Provenance and cleanup

- Read the complete round-3 brief, both relevant source files, client and runner tests, the stdio tests, relevant fake-server scenarios and helpers, package scripts, schema-generation script, TypeScript/Vitest configuration, and the two fix diffs. Compared the pre-fix runner directly from Git for the negative control.
- Did **not** read `2026-09-14-codex-leg-review.md` or `2026-09-14-codex-rereview.md`. No other reviewer output informed this judgment. No subagents were used.
- Ran six consecutive full `npm test` commands in an isolated copy, minimal child-process probes, and the in-process ordering/queued-hook/malformed-result probes described above. The in-process transport used the actual client prototype/parser and compiled runner, replacing process I/O only. It does not establish real pipe chunk boundaries or full integration success.
- Scratch evidence remains under `/tmp/codex-round3-5irGYx`: `run-1.log` through `run-6.log`, `ordering-probe.mjs`, and `old-ordering-probe.mjs`. The scratch runner was restored to the reviewed version after the negative control.
- Personally ran `git status --porcelain` in the original repository before and after the work. Initial and intermediate checks showed only expected untracked review Markdown files. **The final tracked tree is not clean:** `src/app-server-client.ts` and `tests/app-server-client.test.ts` were modified concurrently by another actor. I did not modify either original-tree file, and preserved those changes rather than reverting work I do not own. My only remaining original-tree change is this new report; all reproduction work is in `/tmp`. Thus I cannot provide the brief's requested clean-tree confirmation.
- Inspected the concurrent diff solely to identify the cleanup discrepancy: it wraps the hook in try/catch with request rejection and adds a throwing-hook test. That source change appears to address finding 1 by inspection, but was not part of the reviewed snapshot or six-run experiment and has not been independently validated here. The HEAD commit remained unchanged. The NO-GO verdict is for the original snapshot and outstanding integration verification; it should not be read as claiming the later patch still contains the reproduced exception bug.
