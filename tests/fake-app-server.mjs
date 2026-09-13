#!/usr/bin/env node
// a scripted stand-in for `codex app-server --stdio`, driven by FAKE_SCENARIO.
//
// generic mechanism: readline gives us newline-delimited json-rpc messages off
// stdin as they arrive; `nextMessage()` lets a scenario `await` the next one and
// `send()`/`sendServerRequest()` write json-rpc lines to stdout. each scenario is
// just an async function built from those primitives, registered in `scenarios`
// below -- task 5 can add more scenarios without touching this plumbing.
import readline from "node:readline";

const scenario = process.env.FAKE_SCENARIO;
if (!scenario) {
  process.stderr.write("[fake-app-server] FAKE_SCENARIO env var is required\n");
  process.exit(1);
}

// --- wire primitives --------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

// queue of parsed incoming messages, plus resolvers waiting on the next one
const incoming = [];
const waiters = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushIncoming(message) {
  // stamp the real arrival time (not the time it gets dequeued) so a scenario can prove
  // ordering even when the message was already sitting in the queue by the time it's read
  message._receivedAt = Date.now();
  const waiter = waiters.shift();
  if (waiter) {
    waiter(message);
  } else {
    incoming.push(message);
  }
}

function nextMessage() {
  const queued = incoming.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve) => waiters.push(resolve));
}

// waits for the next incoming request/notification and warns (but doesn't
// throw) if it isn't the method the scenario script expected -- keeps a
// scenario readable as a straight-line script of the protocol it plays out.
async function expect(method) {
  const message = await nextMessage();
  if (message.method !== method) {
    process.stderr.write(
      `[fake-app-server] scenario "${scenario}" expected ${method}, got ${JSON.stringify(message)}\n`,
    );
  }
  return message;
}

function replyResult(request, result) {
  send({ id: request.id, result });
}

function replyError(request, error) {
  send({ id: request.id, error });
}

// sends a server-initiated request and resolves with the client's response
async function sendServerRequest(id, method, params) {
  send({ id, method, params });
  return nextMessage();
}

// reports what a server-initiated request got back, so tests can assert on
// the response shape without a schema validator running inside this process
function echoResponse(response) {
  send({
    method: "test/echo",
    params: {
      receivedId: response.id,
      receivedResult: response.result ?? null,
      receivedError: response.error ?? null,
    },
  });
}

const initializeResult = {
  codexHome: "/tmp/fake-codex-home",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent: "fake-app-server",
};

function threadStartedItem(threadId, turnId) {
  return { threadId, turn: { id: turnId } };
}

async function runHandshakeAndThreadStart() {
  const init = await expect("initialize");
  replyResult(init, initializeResult);

  await expect("initialized"); // notification, no reply

  const threadStart = await expect("thread/start");
  replyResult(threadStart, { thread: { id: "t1" } });
  return threadStart;
}

// sends one item/completed agentMessage notification per entry in `items`
// (each `{text, phase?}`), then turn/completed with status "completed".
async function finishTurn(threadId, turnId, items = [{ phase: "final_answer", text: "pong" }]) {
  items.forEach((item, index) => {
    const id = `item-${index + 1}`;
    send({ method: "item/started", params: { threadId, turnId, item: { id, type: "agentMessage" } } });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id, type: "agentMessage", phase: item.phase, text: item.text },
      },
    });
  });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
}

// minimal, method-appropriate params for each server->client approval/input request in the
// decline table -- see src/responses.ts for what TurnRunner sends back for each of these.
function buildApprovalParams(method, threadId, turnId) {
  const startedAtMs = Date.now();
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { threadId, turnId, itemId: "item-1", startedAtMs, command: ["echo", "hi"] };
    case "item/fileChange/requestApproval":
      return { threadId, turnId, itemId: "item-1", startedAtMs };
    case "item/permissions/requestApproval":
      return { threadId, turnId, itemId: "item-1", startedAtMs, cwd: "/tmp/x", permissions: {} };
    case "execCommandApproval":
      return { callId: "call-1", command: ["echo", "hi"], conversationId: threadId, cwd: "/tmp/x", parsedCmd: [] };
    case "applyPatchApproval":
      return { callId: "call-1", conversationId: threadId, fileChanges: {} };
    case "item/tool/requestUserInput":
      return { threadId, turnId, itemId: "item-1", isBlocking: true, questions: [] };
    case "mcpServer/elicitation/request":
      return { threadId, turnId, serverName: "test-server" };
    default:
      return { threadId, turnId };
  }
}

// --- scenarios ---------------------------------------------------------------

const scenarios = {
  async happy() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });
    await finishTurn(threadId, turnId);
  },

  async "rpc-error"() {
    await expect("initialize").then((init) => replyResult(init, initializeResult));
    await expect("initialized");
    const threadStart = await expect("thread/start");
    replyError(threadStart, {
      code: -32000,
      message: "thread start failed",
      data: { reason: "boom" },
    });
  },

  async "unknown-server-request"() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });

    const response = await sendServerRequest("srv-1", "some/unknown/method", { threadId });
    echoResponse(response);

    await finishTurn(threadId, turnId);
  },

  async "approval-request"() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });

    const method = process.env.FAKE_APPROVAL_METHOD || "item/commandExecution/requestApproval";
    const response = await sendServerRequest("srv-1", method, buildApprovalParams(method, threadId, turnId));
    echoResponse(response);

    await finishTurn(threadId, turnId);
  },

  async "exit-mid-turn"() {
    await runHandshakeAndThreadStart();

    await expect("turn/start"); // never answered -- simulates a crash mid-turn
    process.exit(1);
  },

  async "exit-after-turn-start"() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } }); // turn accepted...
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });
    process.exit(1); // ...then the child dies before any item/turn completion
  },

  async "two-messages"() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });

    await finishTurn(threadId, turnId, [
      { text: "draft" }, // no phase -- interim commentary
      { phase: "final_answer", text: "final" },
    ]);
  },

  async "two-messages-no-final"() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });

    await finishTurn(threadId, turnId, [
      { text: "draft1" },
      { text: "draft2" },
    ]);
  },

  async "failed-turn"() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });

    send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "failed", error: { message: "boom" } } },
    });
  },

  async "turn-start-error"() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    replyError(turnStart, { code: -32000, message: "turn start failed" });
  },

  async "retryable-error"() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });

    send({
      method: "error",
      params: { threadId, turnId, error: { message: "hiccup, retrying" }, willRetry: true },
    });

    await finishTurn(threadId, turnId);
  },

  async hangs() {
    await runHandshakeAndThreadStart();

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });
    // ...then silence -- no item/completed, no turn/completed

    const interrupt = await expect("turn/interrupt");
    replyResult(interrupt, {});
    // deliberately never sends turn/completed either -- TurnRunner must not wait for it
  },

  async "slow-then-done"() {
    await runHandshakeAndThreadStart();

    const turnStart1 = await expect("turn/start");
    const threadId = turnStart1.params.threadId;
    const turnId1 = "u1";
    replyResult(turnStart1, { turn: { id: turnId1 } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId1) });

    await sleep(150); // artificial delay before the first turn finishes
    await finishTurn(threadId, turnId1, [{ phase: "final_answer", text: turnStart1.params.input[0].text }]);
    const turn1FinishedAt = Date.now();

    // if TurnRunner correctly serializes same-thread turns, the second turn/start won't have
    // been written to the wire until after finishTurn() above -- _receivedAt is stamped at the
    // moment bytes arrive, not when this scenario happens to dequeue them, so it proves ordering
    // even though the message may already be sitting in the queue by the time we get here.
    const turnStart2 = await expect("turn/start");
    send({
      method: "test/timing",
      params: { turn1FinishedAt, turn2ReceivedAt: turnStart2._receivedAt },
    });

    const turnId2 = "u2";
    replyResult(turnStart2, { turn: { id: turnId2 } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId2) });
    await finishTurn(threadId, turnId2, [{ phase: "final_answer", text: turnStart2.params.input[0].text }]);
  },

  async "two-threads-concurrent"() {
    const init = await expect("initialize");
    replyResult(init, initializeResult);
    await expect("initialized");

    const threadStart1 = await expect("thread/start");
    replyResult(threadStart1, { thread: { id: "ta" } });
    const threadStart2 = await expect("thread/start");
    replyResult(threadStart2, { thread: { id: "tb" } });

    // both turn/start requests should land close together -- neither thread should be made
    // to wait on the other, unlike same-thread turns in "slow-then-done"
    const first = await expect("turn/start");
    const second = await expect("turn/start");
    send({
      method: "test/timing",
      params: { firstReceivedAt: first._receivedAt, secondReceivedAt: second._receivedAt },
    });

    for (const turnStart of [first, second]) {
      const threadId = turnStart.params.threadId;
      const turnId = `u-${threadId}`;
      replyResult(turnStart, { turn: { id: turnId } });
      send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });
      await finishTurn(threadId, turnId, [{ phase: "final_answer", text: turnStart.params.input[0].text }]);
    }
  },

  // like runHandshakeAndThreadStart, but echoes thread/start's params via test/echo before
  // replying -- lets a test assert what codex-app-mcp actually sent (e.g. the mapped
  // approvalPolicy) without a schema validator running inside this process.
  async "echo-thread-start"() {
    const init = await expect("initialize");
    replyResult(init, initializeResult);
    await expect("initialized");

    const threadStart = await expect("thread/start");
    send({ method: "test/echo", params: { receivedThreadStart: threadStart.params } });
    replyResult(threadStart, { thread: { id: "t1" } });

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });
    await finishTurn(threadId, turnId);
  },

  // thread/resume (an "unknown to this process" threadId, as codex-reply's ensureThread sends)
  // followed by a normal turn -- the "resume" scenario below only exercises thread/resume in
  // isolation, so this covers codex-reply's full ensureThread-then-runTurn path.
  async "resume-then-turn"() {
    const init = await expect("initialize");
    replyResult(init, initializeResult);
    await expect("initialized");

    const resume = await expect("thread/resume");
    replyResult(resume, { thread: { id: resume.params.threadId } });

    const turnStart = await expect("turn/start");
    const threadId = turnStart.params.threadId;
    const turnId = "u1";
    replyResult(turnStart, { turn: { id: turnId } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnId) });
    await finishTurn(threadId, turnId, [{ phase: "final_answer", text: turnStart.params.input[0].text }]);
  },

  // thread/resume succeeds (as codex-reply's ensureThread expects), but turn/start itself then
  // errors -- covers codex-reply's "runTurn rejected" path, where structuredContent.threadId
  // must still be present since the id came from the caller, not from a thread/start we made.
  async "resume-then-turn-start-error"() {
    const init = await expect("initialize");
    replyResult(init, initializeResult);
    await expect("initialized");

    const resume = await expect("thread/resume");
    replyResult(resume, { thread: { id: resume.params.threadId } });

    const turnStart = await expect("turn/start");
    replyError(turnStart, { code: -32000, message: "turn start failed" });
  },

  // reproduces the timeout->stale-event race: turn A times out client-side (which fires
  // turn/interrupt but doesn't wait for the app-server to actually stop the turn), a second
  // turn B starts on the SAME threadId, and only then does A's late item/completed +
  // turn/completed arrive on the wire, carrying A's turnId. TurnRunner must correlate by
  // turnId (not just threadId) so B's listeners ignore A's stale events entirely.
  async "stale-turn-after-timeout"() {
    await runHandshakeAndThreadStart();

    const turnStartA = await expect("turn/start");
    const threadId = turnStartA.params.threadId;
    const turnIdA = "uA";
    replyResult(turnStartA, { turn: { id: turnIdA } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnIdA) });

    // client times out and interrupts -- reply, but keep A "running" server-side
    const interrupt = await expect("turn/interrupt");
    replyResult(interrupt, {});

    // turn B starts on the same threadId once A's synthesized interrupt unblocks the lock
    const turnStartB = await expect("turn/start");
    const turnIdB = "uB";
    replyResult(turnStartB, { turn: { id: turnIdB } });
    send({ method: "turn/started", params: threadStartedItem(threadId, turnIdB) });

    // A's late events arrive only now, after B's turnId is already known client-side --
    // these must be ignored, not mistaken for B's own completion
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId: turnIdA,
        item: { id: "stale-item", type: "agentMessage", phase: "final_answer", text: "STALE-A" },
      },
    });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnIdA, status: "completed" } } });

    await finishTurn(threadId, turnIdB, [{ phase: "final_answer", text: "real-B" }]);
  },

  // thread/resume itself returns a JSON-RPC error -- covers codex-reply's ensureThread failing
  // before any turn/start is ever attempted, unlike "resume-then-turn-start-error" which fails
  // later, after a successful resume.
  async "resume-error"() {
    const init = await expect("initialize");
    replyResult(init, initializeResult);
    await expect("initialized");

    const resume = await expect("thread/resume");
    replyError(resume, { code: -32000, message: "thread resume failed" });
  },

  async resume() {
    const init = await expect("initialize");
    replyResult(init, initializeResult);
    await expect("initialized");

    const first = await expect("thread/resume");
    replyResult(first, { thread: { id: first.params.threadId } });

    // a well-behaved TurnRunner never sends a second thread/resume for an id it already knows
    // about; if it does anyway, delay the reply so a timing assertion in the test can catch it
    // instead of the bug silently passing
    const second = await nextMessage();
    if (second.method === "thread/resume") {
      await sleep(300);
      replyResult(second, { thread: { id: second.params.threadId } });
    }
  },
};

// --- driver --------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  try {
    pushIncoming(JSON.parse(line));
  } catch {
    process.stderr.write(`[fake-app-server] malformed json line, skipping: ${line}\n`);
  }
});

const run = scenarios[scenario];
if (!run) {
  process.stderr.write(`[fake-app-server] unknown scenario: ${scenario}\n`);
  process.exit(1);
}

run().catch((err) => {
  process.stderr.write(`[fake-app-server] scenario "${scenario}" failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
