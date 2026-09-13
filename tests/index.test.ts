// lighter-touch coverage for src/index.ts: the lazy-spawn/respawn wiring around TurnRunner. a
// full stdio E2E (spawning `node dist/index.js` and talking MCP over its stdio) is left to Task
// 7's live smoke test -- this only exercises createLazyTurnRunner directly, which is where all
// of index.ts's non-trivial logic lives (main() itself is just registerTool + connect wiring).
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { AppServerClient } from "../src/app-server-client.js";
import type { ThreadSettings } from "../src/turn-runner.js";
import { createLazyTurnRunner } from "../src/index.js";

const fakeServerPath = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));
const readOnlySettings: ThreadSettings = { approvalPolicy: "never", sandbox: "read-only", cwd: "/tmp/x" };

const clients: AppServerClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function makeClient(scenario: string): AppServerClient {
  const client = new AppServerClient({
    command: process.execPath,
    args: [fakeServerPath],
    env: { ...process.env, FAKE_SCENARIO: scenario },
  });
  clients.push(client);
  return client;
}

describe("createLazyTurnRunner", () => {
  it("does not spawn a client until the first call", () => {
    let spawnCount = 0;
    createLazyTurnRunner({
      createClient: () => {
        spawnCount++;
        return makeClient("happy");
      },
    });

    expect(spawnCount).toBe(0);
  });

  it("spawns exactly one client for the first call, and reuses it for a subsequent call on the same thread", async () => {
    let spawnCount = 0;
    const lazy = createLazyTurnRunner({
      createClient: () => {
        spawnCount++;
        return makeClient("slow-then-done");
      },
    });

    const { threadId } = await lazy.startThread(readOnlySettings);
    expect(spawnCount).toBe(1);

    const result = await lazy.runTurn(threadId, "turn1");
    expect(result.status).toBe("completed");
    expect(spawnCount).toBe(1); // still the same child
  });

  it("respawns a fresh client on the next call after the previous child exits", async () => {
    let spawnCount = 0;
    const lazy = createLazyTurnRunner({
      createClient: () => {
        spawnCount++;
        // this scenario accepts turn/start then exits before completing the turn
        return makeClient("exit-after-turn-start");
      },
    });

    const { threadId } = await lazy.startThread(readOnlySettings);
    expect(spawnCount).toBe(1);

    await expect(lazy.runTurn(threadId, "hi")).rejects.toMatchObject({ name: "AppServerExited" });

    // the dead client's onExit handler clears the cached session synchronously, so the very next
    // call should spawn a brand new client rather than reusing (or hanging on) the dead one
    await lazy.startThread(readOnlySettings);
    expect(spawnCount).toBe(2);
  });
});
