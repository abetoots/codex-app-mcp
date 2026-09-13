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

function pushIncoming(message) {
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

async function finishTurn(threadId, turnId) {
  send({ method: "item/started", params: { threadId, item: { id: "item-1", type: "agentMessage" } } });
  send({
    method: "item/completed",
    params: {
      threadId,
      item: { id: "item-1", type: "agentMessage", phase: "final_answer", text: "pong" },
    },
  });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
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

    const response = await sendServerRequest("srv-1", "item/commandExecution/requestApproval", {
      threadId,
      turnId,
      callId: "call-1",
      command: ["echo", "hi"],
    });
    echoResponse(response);

    await finishTurn(threadId, turnId);
  },

  async "exit-mid-turn"() {
    await runHandshakeAndThreadStart();

    await expect("turn/start"); // never answered -- simulates a crash mid-turn
    process.exit(1);
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
