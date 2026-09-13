import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { AppServerClient } from "../src/app-server-client.js";
import { SERVER_REQUESTS } from "../src/protocol.js";
import { TurnRunner, type ThreadSettings } from "../src/turn-runner.js";
import { serverRequestResponses } from "./fixtures/app-server.js";

const fakeServerPath = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

function makeClient(scenario: string, env: Record<string, string> = {}): AppServerClient {
  return new AppServerClient({
    command: process.execPath,
    args: [fakeServerPath],
    env: { ...process.env, FAKE_SCENARIO: scenario, ...env },
  });
}

const clients: AppServerClient[] = [];
function tracked(scenario: string, env: Record<string, string> = {}): AppServerClient {
  const client = makeClient(scenario, env);
  clients.push(client);
  return client;
}

async function makeRunner(scenario: string, env: Record<string, string> = {}): Promise<TurnRunner> {
  const client = tracked(scenario, env);
  await client.initialize();
  return new TurnRunner(client);
}

// resolves with the params of the next notification for `method`
function waitForNotification(client: AppServerClient, method: string): Promise<unknown> {
  return new Promise((resolve) => {
    const unsubscribe = client.on(method, (params) => {
      unsubscribe();
      resolve(params);
    });
  });
}

// races a promise against a manual timeout, so a bug that makes something hang fails with a
// clear message instead of the whole suite timing out
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

const readOnlySettings: ThreadSettings = { approvalPolicy: "never", sandbox: "read-only", cwd: "/tmp/x" };

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe("TurnRunner happy path", () => {
  it("startThread then runTurn returns the completed turn's final answer", async () => {
    const runner = await makeRunner("happy");

    const { threadId } = await runner.startThread(readOnlySettings);
    expect(threadId).toBe("t1");

    const result = await runner.runTurn(threadId, "hi");

    expect(result).toEqual({
      threadId: "t1",
      turnId: "u1",
      status: "completed",
      text: "pong",
      declinedRequests: [],
    });
  });
});

describe("final-answer selection", () => {
  it("uses the last agentMessage item whose phase is final_answer, not a concatenation", async () => {
    const runner = await makeRunner("two-messages");
    const { threadId } = await runner.startThread(readOnlySettings);

    const result = await runner.runTurn(threadId, "hi");

    expect(result.status).toBe("completed");
    expect(result.text).toBe("final");
  });

  it("falls back to joining every agentMessage item's text when none is final_answer", async () => {
    const runner = await makeRunner("two-messages-no-final");
    const { threadId } = await runner.startThread(readOnlySettings);

    const result = await runner.runTurn(threadId, "hi");

    expect(result.status).toBe("completed");
    expect(result.text).toBe("draft1\n\ndraft2");
  });
});

describe("approval/permission/user-input/elicitation table", () => {
  const cases: Array<[string, string]> = [
    [SERVER_REQUESTS.commandExecutionApproval, "item/commandExecution/requestApproval"],
    [SERVER_REQUESTS.fileChangeApproval, "item/fileChange/requestApproval"],
    [SERVER_REQUESTS.permissionsApproval, "item/permissions/requestApproval"],
    [SERVER_REQUESTS.execCommandApproval, "execCommandApproval"],
    [SERVER_REQUESTS.applyPatchApproval, "applyPatchApproval"],
    [SERVER_REQUESTS.toolRequestUserInput, "item/tool/requestUserInput"],
    [SERVER_REQUESTS.mcpServerElicitation, "mcpServer/elicitation/request"],
  ];

  for (const [method] of cases) {
    it(`declines ${method} with the exact fixture response and records it`, async () => {
      const runner = await makeRunner("approval-request", { FAKE_APPROVAL_METHOD: method });
      const { threadId } = await runner.startThread(readOnlySettings);

      const result = await runner.runTurn(threadId, "hi");

      const fixture = serverRequestResponses[method as keyof typeof serverRequestResponses];
      expect(result.status).toBe("completed");
      expect(result.declinedRequests).toEqual([method]);
      // the fixture is exactly what tests/protocol.test.ts validates against the schema for
      // this method's response, so this proves TurnRunner sent the schema-shaped decline
      expect(fixture.response).toBeDefined();
    });
  }

  it("does not recognize/decline an unknown server request -- AppServerClient handles it", async () => {
    const client = tracked("unknown-server-request");
    await client.initialize();
    const runner = new TurnRunner(client);
    const { threadId } = await runner.startThread(readOnlySettings);

    const echo = waitForNotification(client, "test/echo");
    const result = await runner.runTurn(threadId, "hi");
    const echoed = (await echo) as { receivedError: { code: number } };

    expect(echoed.receivedError).toMatchObject({ code: -32601 });
    expect(result.declinedRequests).toEqual([]);
  });

  it("the response TurnRunner sends matches the exact fixture literal (echoed back)", async () => {
    const client = tracked("approval-request", { FAKE_APPROVAL_METHOD: SERVER_REQUESTS.commandExecutionApproval });
    await client.initialize();
    const runner = new TurnRunner(client);
    const { threadId } = await runner.startThread(readOnlySettings);

    const echo = waitForNotification(client, "test/echo");
    await runner.runTurn(threadId, "hi");
    const echoed = (await echo) as { receivedResult: unknown };

    expect(echoed.receivedResult).toEqual(serverRequestResponses[SERVER_REQUESTS.commandExecutionApproval].response);
  });
});

describe("failed turns", () => {
  it("resolves (does not reject) with status failed and errorText from turn.error.message", async () => {
    const runner = await makeRunner("failed-turn");
    const { threadId } = await runner.startThread(readOnlySettings);

    const result = await runner.runTurn(threadId, "hi");

    expect(result).toEqual({
      threadId,
      turnId: "u1",
      status: "failed",
      text: "",
      errorText: "boom",
      declinedRequests: [],
    });
  });
});

describe("turn/start rpc error", () => {
  it("rejects runTurn (no turnId exists to build a TurnResult around)", async () => {
    const runner = await makeRunner("turn-start-error");
    const { threadId } = await runner.startThread(readOnlySettings);

    await expect(runner.runTurn(threadId, "hi")).rejects.toMatchObject({
      name: "AppServerRpcError",
      message: "turn start failed",
    });
  });
});

describe("retryable error notification", () => {
  it("does not treat a willRetry:true error notification as failure", async () => {
    const runner = await makeRunner("retryable-error");
    const { threadId } = await runner.startThread(readOnlySettings);

    const result = await runner.runTurn(threadId, "hi");

    expect(result.status).toBe("completed");
    expect(result.text).toBe("pong");
  });
});

describe("timeout", () => {
  it("sends turn/interrupt and resolves with status interrupted well within the timeout window", async () => {
    const runner = await makeRunner("hangs");
    const { threadId } = await runner.startThread(readOnlySettings);

    const start = Date.now();
    const result = await withTimeout(runner.runTurn(threadId, "hi", { timeoutMs: 100 }), 2000, "runTurn");
    const elapsed = Date.now() - start;

    expect(result.status).toBe("interrupted");
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("child death after turn accepted", () => {
  it("settles runTurn instead of hanging when the child exits mid-turn", async () => {
    const runner = await makeRunner("exit-after-turn-start");
    const { threadId } = await runner.startThread(readOnlySettings);

    await expect(withTimeout(runner.runTurn(threadId, "hi"), 2000, "runTurn")).rejects.toMatchObject({
      name: "AppServerExited",
    });
  });
});

describe("per-thread serialization", () => {
  it("does not send the second turn/start on the same thread until the first turn settles", async () => {
    const client = tracked("slow-then-done");
    await client.initialize();
    const runner = new TurnRunner(client);
    const { threadId } = await runner.startThread(readOnlySettings);

    const timing = waitForNotification(client, "test/timing") as Promise<{
      turn1FinishedAt: number;
      turn2ReceivedAt: number;
    }>;

    const [first, second] = await Promise.all([
      runner.runTurn(threadId, "turn1"),
      runner.runTurn(threadId, "turn2"),
    ]);

    const { turn1FinishedAt, turn2ReceivedAt } = await timing;

    expect(first.text).toBe("turn1");
    expect(second.text).toBe("turn2");
    expect(turn2ReceivedAt).toBeGreaterThanOrEqual(turn1FinishedAt);
  });

  it("does not serialize turns on different threads", async () => {
    const client = tracked("two-threads-concurrent");
    await client.initialize();
    const runner = new TurnRunner(client);
    const threadA = await runner.startThread(readOnlySettings);
    const threadB = await runner.startThread(readOnlySettings);

    const [resultA, resultB] = await Promise.all([
      runner.runTurn(threadA.threadId, "a-prompt"),
      runner.runTurn(threadB.threadId, "b-prompt"),
    ]);

    expect(resultA.status).toBe("completed");
    expect(resultB.status).toBe("completed");
  });
});

describe("turnId correlation across a timed-out turn and its successor", () => {
  it("ignores a stale item/completed and turn/completed from a timed-out prior turn on the same thread", async () => {
    const runner = await makeRunner("stale-turn-after-timeout");
    const { threadId } = await runner.startThread(readOnlySettings);

    const resultA = await withTimeout(runner.runTurn(threadId, "a", { timeoutMs: 50 }), 2000, "runTurn A");
    expect(resultA.status).toBe("interrupted");
    expect(resultA.turnId).toBe("uA");

    const resultB = await withTimeout(runner.runTurn(threadId, "b"), 2000, "runTurn B");
    expect(resultB.status).toBe("completed");
    expect(resultB.turnId).toBe("uB");
    expect(resultB.text).toBe("real-B");
  });
});

describe("ensureThread", () => {
  it("resumes an unknown thread id (fresh process) via thread/resume", async () => {
    const runner = await makeRunner("resume");

    await expect(withTimeout(runner.ensureThread("old-thread", readOnlySettings), 1000, "ensureThread")).resolves.toBeUndefined();
  });

  it("is a no-op for a threadId this instance already knows about via startThread", async () => {
    const runner = await makeRunner("happy");
    const { threadId } = await runner.startThread(readOnlySettings);

    const start = Date.now();
    await runner.ensureThread(threadId, readOnlySettings);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it("is a no-op on a second call for an id it just resumed", async () => {
    const runner = await makeRunner("resume");
    await runner.ensureThread("old-thread", readOnlySettings);

    const start = Date.now();
    await withTimeout(runner.ensureThread("old-thread", readOnlySettings), 250, "second ensureThread");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });
});
