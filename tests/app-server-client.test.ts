import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { AppServerClient, AppServerExited, AppServerRpcError } from "../src/app-server-client.js";
import { CLIENT_REQUESTS, SERVER_NOTIFICATIONS, SERVER_REQUESTS } from "../src/protocol.js";
import { clientRequests } from "./fixtures/app-server.js";

const fakeServerPath = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

function makeClient(scenario: string): AppServerClient {
  return new AppServerClient({
    command: process.execPath,
    args: [fakeServerPath],
    env: { ...process.env, FAKE_SCENARIO: scenario },
  });
}

// resolves with the params of the next notification for `method`, set up
// synchronously so it can't miss a notification that fires before it's awaited
function waitForNotification(client: AppServerClient, method: string): Promise<unknown> {
  return new Promise((resolve) => {
    const unsubscribe = client.on(method, (params) => {
      unsubscribe();
      resolve(params);
    });
  });
}

const clients: AppServerClient[] = [];
function tracked(scenario: string): AppServerClient {
  const client = makeClient(scenario);
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe("AppServerClient", () => {
  it("initialize() completes the handshake against the happy scenario", async () => {
    const client = tracked("happy");
    const result = await client.initialize();
    expect(result).toMatchObject({ platformOs: "linux" });
  });

  it("request() resolves with the response result for a matching id", async () => {
    const client = tracked("happy");
    await client.initialize();
    const result = await client.request(CLIENT_REQUESTS.threadStart, clientRequests.threadStart.params);
    expect(result).toEqual({ thread: { id: "t1" } });
  });

  it("request() rejects with AppServerRpcError when the server returns an error", async () => {
    const client = tracked("rpc-error");
    await client.initialize();
    await expect(client.request(CLIENT_REQUESTS.threadStart, clientRequests.threadStart.params)).rejects.toMatchObject(
      {
        name: "AppServerRpcError",
        code: -32000,
        message: "thread start failed",
      },
    );
  });

  it("request() rejection carries an AppServerRpcError instance with .data", async () => {
    const client = tracked("rpc-error");
    await client.initialize();
    await expect(
      client.request(CLIENT_REQUESTS.threadStart, clientRequests.threadStart.params),
    ).rejects.toBeInstanceOf(AppServerRpcError);
  });

  it("on(method, handler) receives notifications, and the returned unsubscribe stops delivery", async () => {
    const client = tracked("happy");
    await client.initialize();
    await client.request(CLIENT_REQUESTS.threadStart, clientRequests.threadStart.params);

    const stillSubscribed: unknown[] = [];
    const unsubscribedCalls: unknown[] = [];
    client.on(SERVER_NOTIFICATIONS.turnStarted, (params) => stillSubscribed.push(params));
    const unsubscribe = client.on(SERVER_NOTIFICATIONS.turnStarted, (params) => unsubscribedCalls.push(params));
    unsubscribe();

    const completed = waitForNotification(client, SERVER_NOTIFICATIONS.turnCompleted);
    await client.request(CLIENT_REQUESTS.turnStart, clientRequests.turnStart.params);
    await completed;

    expect(stillSubscribed.length).toBe(1);
    expect(unsubscribedCalls.length).toBe(0);
  });

  it("onServerRequest: a resolving handler answers the server's request with {result}", async () => {
    const client = tracked("approval-request");
    await client.initialize();
    await client.request(CLIENT_REQUESTS.threadStart, clientRequests.threadStart.params);

    const decision = { decision: "decline" };
    client.onServerRequest((method) => {
      expect(method).toBe(SERVER_REQUESTS.commandExecutionApproval);
      return decision;
    });

    const echo = waitForNotification(client, "test/echo");
    await client.request(CLIENT_REQUESTS.turnStart, clientRequests.turnStart.params);
    const params = (await echo) as { receivedResult: unknown; receivedError: unknown };

    expect(params.receivedError).toBeNull();
    expect(params.receivedResult).toEqual(decision);
  });

  it("an unhandled server request gets an automatic -32601 response", async () => {
    const client = tracked("unknown-server-request");
    await client.initialize();
    await client.request(CLIENT_REQUESTS.threadStart, clientRequests.threadStart.params);

    // no onServerRequest handler registered at all

    const echo = waitForNotification(client, "test/echo");
    await client.request(CLIENT_REQUESTS.turnStart, clientRequests.turnStart.params);
    const params = (await echo) as { receivedResult: unknown; receivedError: { code: number; message: string } };

    expect(params.receivedResult).toBeNull();
    expect(params.receivedError).toMatchObject({ code: -32601 });
    expect(params.receivedError.message).toContain("some/unknown/method");
  });

  it("a handler returning undefined also gets an automatic -32601 response", async () => {
    const client = tracked("unknown-server-request");
    await client.initialize();
    await client.request(CLIENT_REQUESTS.threadStart, clientRequests.threadStart.params);

    client.onServerRequest(() => undefined);

    const echo = waitForNotification(client, "test/echo");
    await client.request(CLIENT_REQUESTS.turnStart, clientRequests.turnStart.params);
    const params = (await echo) as { receivedError: { code: number } };

    expect(params.receivedError).toMatchObject({ code: -32601 });
  });

  it("child exit rejects pending requests with AppServerExited and notifies onExit", async () => {
    const client = tracked("exit-mid-turn");
    await client.initialize();
    await client.request(CLIENT_REQUESTS.threadStart, clientRequests.threadStart.params);

    const exited = new Promise((resolve) => client.onExit(resolve));

    await expect(client.request(CLIENT_REQUESTS.turnStart, clientRequests.turnStart.params)).rejects.toBeInstanceOf(
      AppServerExited,
    );

    const err = await exited;
    expect(err).toBeInstanceOf(AppServerExited);
  });

  it("queues requests issued before initialize() resolves and resolves them after the handshake", async () => {
    const client = tracked("happy");
    const initializePromise = client.initialize();
    const threadStartPromise = client.request(CLIENT_REQUESTS.threadStart, clientRequests.threadStart.params);

    await initializePromise;
    const result = await threadStartPromise;

    expect(result).toEqual({ thread: { id: "t1" } });
  });
});
