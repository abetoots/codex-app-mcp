// live end-to-end smoke test against the REAL `codex app-server` child process -- no fake
// server here. skipped unless CODEX_LIVE=1 is set, so `npm test` stays fast and offline. run
// with `CODEX_LIVE=1 npx vitest run tests/live.smoke.test.ts` (or `bin/smoke.sh`) after every
// `codex update` to catch app-server protocol drift.
import { afterEach, describe, expect, it } from "vitest";

import { AppServerClient } from "../src/app-server-client.js";
import { TurnRunner } from "../src/turn-runner.js";
import { createCodexTool } from "../src/tools.js";

const LIVE_TIMEOUT_MS = 30_000;

// tracked so afterEach can close every client this file spawns, even ones from a test that
// throws partway through -- no orphaned `codex app-server` processes left behind.
const clients: AppServerClient[] = [];

function spawnClient(): AppServerClient {
  const client = new AppServerClient({
    command: process.env.CODEX_BIN ?? "codex",
    args: ["app-server", "--stdio"],
  });
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe.skipIf(!process.env.CODEX_LIVE)("live smoke: real codex app-server", () => {
  it(
    "starts a thread, replies, continues same-process, and resumes cross-process",
    async () => {
      // 1-2: fresh client + turn runner, new thread, first turn
      const client1 = spawnClient();
      await client1.initialize();
      const runner1 = new TurnRunner(client1);

      const { threadId } = await runner1.startThread({
        sandbox: "read-only",
        approvalPolicy: "never",
        cwd: process.cwd(),
      });
      expect(threadId).toBeTruthy();

      // 3: first turn -- explicit instruction, lenient on trailing punctuation
      const first = await runner1.runTurn(threadId, "Reply with exactly: pong");
      expect(first.status).toBe("completed");
      expect(first.text.trim().toLowerCase().replace(/[.!]+$/, "")).toBe("pong");

      // 4: same-process continuation -- same runner, same thread
      const second = await runner1.runTurn(threadId, "What did you just say? Reply with just that word.");
      expect(second.status).toBe("completed");
      expect(second.text.toLowerCase()).toContain("pong");

      // 5: close client1, spawn a brand new client+runner (simulating a process restart),
      // ensureThread() should thread/resume rather than thread/start, and continuation
      // must still work across that boundary.
      client1.close();

      const client2 = spawnClient();
      await client2.initialize();
      const runner2 = new TurnRunner(client2);

      await runner2.ensureThread(threadId, { approvalPolicy: "never", sandbox: "read-only" });
      const third = await runner2.runTurn(threadId, "What did you just say? Reply with just that word.");
      expect(third.status).toBe("completed");
      expect(third.text.toLowerCase()).toContain("pong");
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "exercises the tools.ts handler end-to-end against the real app-server",
    async () => {
      // 6: the actual MCP tool contract, not just TurnRunner directly
      const client = spawnClient();
      await client.initialize();
      const runner = new TurnRunner(client);
      const tool = createCodexTool(runner);

      // tool.handler is called directly (not through the MCP server), so zod defaults are
      // not applied automatically -- supply the fully-populated shape ourselves, matching
      // the same pattern tests/tools.test.ts uses against the fake server.
      const input = {
        prompt: "Reply with exactly: pong",
        model: undefined,
        profile: undefined,
        cwd: undefined,
        "approval-policy": "never" as const,
        sandbox: "read-only" as const,
        config: undefined,
        "base-instructions": undefined,
        "developer-instructions": undefined,
        "compact-prompt": undefined,
        "timeout-seconds": 900,
      };
      const fakeExtra = { sendNotification: async () => {} };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await tool.handler(input, fakeExtra as any);

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      expect(text.toLowerCase()).toContain("pong");
      expect(result.structuredContent).toBeDefined();
      expect((result.structuredContent as { threadId?: string }).threadId).toBeTruthy();
      expect((result.structuredContent as { status?: string }).status).toBe("completed");
    },
    LIVE_TIMEOUT_MS,
  );
});
