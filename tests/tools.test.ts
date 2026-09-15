import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServerClient } from "../src/app-server-client.js";
import { TurnRunner } from "../src/turn-runner.js";
import { createCodexTool, createCodexReplyTool, type TurnRunnerLike } from "../src/tools.js";

const fakeServerPath = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

const clients: AppServerClient[] = [];

function tracked(scenario: string, env: Record<string, string> = {}): AppServerClient {
  const client = new AppServerClient({
    command: process.execPath,
    args: [fakeServerPath],
    env: { ...process.env, FAKE_SCENARIO: scenario, ...env },
  });
  clients.push(client);
  return client;
}

async function makeRunner(scenario: string, env: Record<string, string> = {}): Promise<TurnRunner> {
  const client = tracked(scenario, env);
  await client.initialize();
  return new TurnRunner(client);
}

function waitForNotification(client: AppServerClient, method: string): Promise<unknown> {
  return new Promise((resolve) => {
    const unsubscribe = client.on(method, (params) => {
      unsubscribe();
      resolve(params);
    });
  });
}

// a minimal RequestHandlerExtra stand-in -- the handlers under test only touch _meta and
// sendNotification (for progress pings), so that's all this needs to provide.
function fakeExtra(progressToken?: string): {
  _meta?: { progressToken: string };
  sendNotification: ReturnType<typeof vi.fn>;
} {
  return {
    _meta: progressToken !== undefined ? { progressToken } : undefined,
    sendNotification: vi.fn(async () => {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asExtra(fake: ReturnType<typeof fakeExtra>): any {
  return fake;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

const defaultCodexInput = {
  prompt: "hi",
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

describe("codex tool", () => {
  it("happy path: default approval-policy/sandbox, threadId present, final answer text, no isError", async () => {
    const runner = await makeRunner("happy");
    const tool = createCodexTool(runner);

    const result = await tool.handler(defaultCodexInput, asExtra(fakeExtra()));

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    expect(result.structuredContent).toMatchObject({
      threadId: "t1",
      turnId: "u1",
      status: "completed",
      declinedRequests: [],
    });
  });

  it("a turn that completes with zero text is treated as an error, not a silent empty success", async () => {
    const runner = await makeRunner("completed-with-no-text");
    const tool = createCodexTool(runner);

    const result = await tool.handler(defaultCodexInput, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0);
    expect((result.content[0] as { text: string }).text).toMatch(/no text|stale|empty/i);
    expect(result.structuredContent).toMatchObject({
      threadId: "t1",
      turnId: "u1",
      status: "completed",
      declinedRequests: [],
    });
    // structuredContent must explain the failure, not just report status:"completed" bare
    expect(typeof (result.structuredContent as { errorText?: unknown }).errorText).toBe("string");
  });

  it("surfaces the real upstream reason (not the generic guess) when app-server sent one", async () => {
    const runner = await makeRunner("usage-limit-then-empty");
    const tool = createCodexTool(runner);

    const result = await tool.handler(defaultCodexInput, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("usageLimitExceeded");
    expect(text).toContain("You've hit your usage limit.");
    expect(result.structuredContent).toMatchObject({
      upstreamErrors: [{ message: "You've hit your usage limit.", code: "usageLimitExceeded" }],
    });
    expect((result.structuredContent as { errorText: string }).errorText).toContain("usageLimitExceeded");
  });

  it("rejects `profile` without ever calling the TurnRunner", async () => {
    const startThread = vi.fn();
    const runTurn = vi.fn();
    const ensureThread = vi.fn();
    const stub: TurnRunnerLike = { startThread, runTurn, ensureThread };
    const tool = createCodexTool(stub);

    const result = await tool.handler({ ...defaultCodexInput, profile: "my-profile" }, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toMatch(/profile/i);
    expect((result.content[0] as { text: string }).text).toMatch(/ThreadStartParams/);
    expect(startThread).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
    expect(result.structuredContent).toBeUndefined();
  });

  it("maps approval-policy 'on-failure' to 'on-request' sent to app-server, and notes the substitution", async () => {
    const runner = await makeRunner("echo-thread-start");
    const tool = createCodexTool(runner);

    const client = clients[clients.length - 1];
    const echo = waitForNotification(client, "test/echo") as Promise<{
      receivedThreadStart: { approvalPolicy: string };
    }>;

    const result = await tool.handler({ ...defaultCodexInput, "approval-policy": "on-failure" }, asExtra(fakeExtra()));
    const { receivedThreadStart } = await echo;

    expect(receivedThreadStart.approvalPolicy).toBe("on-request");
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toMatch(/on-failure.*on-request/);
  });

  it("folds compact-prompt into developer-instructions and notes it", async () => {
    const runner = await makeRunner("happy");
    const tool = createCodexTool(runner);

    const result = await tool.handler(
      { ...defaultCodexInput, "developer-instructions": "be terse", "compact-prompt": "summarize now" },
      asExtra(fakeExtra()),
    );

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toMatch(/compact-prompt/);
  });

  it("thread/start succeeds but turn/start itself errors -> isError, threadId still present", async () => {
    const runner = await makeRunner("turn-start-error");
    const tool = createCodexTool(runner);

    const result = await tool.handler(defaultCodexInput, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ threadId: "t1" });
    expect((result.content[0] as { text: string }).text).toMatch(/turn start failed/);
  });

  it("thread/start itself fails -> isError, no threadId was ever obtained so structuredContent has none", async () => {
    const runner = await makeRunner("rpc-error");
    const tool = createCodexTool(runner);

    const result = await tool.handler(defaultCodexInput, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.threadId).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toMatch(/thread start failed/);
  });

  it("a turn resolving with status failed -> isError, errorText present, threadId present", async () => {
    const runner = await makeRunner("failed-turn");
    const tool = createCodexTool(runner);

    const result = await tool.handler(defaultCodexInput, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ threadId: "t1", status: "failed", errorText: "boom" });
    expect((result.content[0] as { text: string }).text).toMatch(/boom/);
  });

  it("a turn interrupted by caller timeout -> isError, threadId present", async () => {
    const runner = await makeRunner("hangs");
    const tool = createCodexTool(runner);

    const result = await tool.handler({ ...defaultCodexInput, "timeout-seconds": 1 }, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ threadId: "t1", status: "interrupted" });
    expect((result.content[0] as { text: string }).text).toMatch(/interrupted/);
  }, 3000);

  it("sends notifications/progress roughly every 10s while a turn is in flight, when a progressToken is present", async () => {
    vi.useFakeTimers();
    try {
      const startThread = vi.fn().mockResolvedValue({ threadId: "t1" });
      let resolveRunTurn: (value: unknown) => void = () => {};
      const runTurn = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = resolve;
          }),
      );
      const stub: TurnRunnerLike = { startThread, runTurn, ensureThread: vi.fn() } as unknown as TurnRunnerLike;
      const tool = createCodexTool(stub);
      const extra = fakeExtra("token-1");

      const handlerPromise = tool.handler(defaultCodexInput, asExtra(extra));
      await vi.advanceTimersByTimeAsync(25_000);

      expect(extra.sendNotification).toHaveBeenCalledTimes(2);
      expect(extra.sendNotification).toHaveBeenCalledWith({
        method: "notifications/progress",
        params: { progressToken: "token-1", progress: 1 },
      });

      resolveRunTurn({
        threadId: "t1",
        turnId: "u1",
        status: "completed",
        text: "pong",
        declinedRequests: [],
      });
      await handlerPromise;

      await vi.advanceTimersByTimeAsync(30_000);
      expect(extra.sendNotification).toHaveBeenCalledTimes(2); // no more pings after settling
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send progress notifications when no progressToken is present", async () => {
    const runner = await makeRunner("happy");
    const tool = createCodexTool(runner);
    const extra = fakeExtra();

    await tool.handler(defaultCodexInput, asExtra(extra));

    expect(extra.sendNotification).not.toHaveBeenCalled();
  });
});

const defaultReplyInput = { threadId: undefined, conversationId: undefined, prompt: "what did you say?", "timeout-seconds": 900 };

describe("codex-reply tool", () => {
  it("happy path with threadId continues correctly, structuredContent.threadId present", async () => {
    const runner = await makeRunner("resume-then-turn");
    const tool = createCodexReplyTool(runner);

    const result = await tool.handler({ ...defaultReplyInput, threadId: "old-thread" }, asExtra(fakeExtra()));

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "what did you say?" }]);
    expect(result.structuredContent).toMatchObject({ threadId: "old-thread", status: "completed" });
  });

  it("a resumed turn that completes with zero text is treated as an error, matching the codex tool's behavior", async () => {
    const runner = await makeRunner("resume-then-empty-turn");
    const tool = createCodexReplyTool(runner);

    const result = await tool.handler({ ...defaultReplyInput, threadId: "old-thread" }, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/no text|stale|empty/i);
    expect(result.structuredContent).toMatchObject({ threadId: "old-thread", status: "completed" });
    expect(typeof (result.structuredContent as { errorText?: unknown }).errorText).toBe("string");
  });

  it("honors the deprecated conversationId alias when threadId is absent", async () => {
    const runner = await makeRunner("resume-then-turn");
    const tool = createCodexReplyTool(runner);

    const result = await tool.handler({ ...defaultReplyInput, conversationId: "legacy-thread" }, asExtra(fakeExtra()));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ threadId: "legacy-thread" });
  });

  it("rejects a call with neither threadId nor conversationId via zod validation, without crashing", () => {
    const runner = { startThread: vi.fn(), ensureThread: vi.fn(), runTurn: vi.fn() } as unknown as TurnRunnerLike;
    const tool = createCodexReplyTool(runner);

    const parsed = tool.inputSchema.safeParse({ prompt: "hi" });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(String(parsed.error)).toMatch(/threadId \(or the deprecated conversationId\) is required/);
    }
  });

  it("calls ensureThread for a threadId unknown to this process, and resolves via thread/resume without error", async () => {
    const runner = await makeRunner("resume-then-turn");
    const tool = createCodexReplyTool(runner);

    const result = await tool.handler({ ...defaultReplyInput, threadId: "never-seen-before" }, asExtra(fakeExtra()));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ threadId: "never-seen-before" });
  });

  it("ensureThread rejecting (thread/resume itself returns a JSON-RPC error) -> isError:true with a sensible message", async () => {
    const runner = await makeRunner("resume-error");
    const tool = createCodexReplyTool(runner);

    const result = await tool.handler({ ...defaultReplyInput, threadId: "old-thread" }, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ threadId: "old-thread", errorText: "thread resume failed" });
    expect((result.content[0] as { text: string }).text).toMatch(/thread resume failed/);
  });

  it("runTurn rejecting (turn/start errors after a successful resume) still reports structuredContent.threadId", async () => {
    const runner = await makeRunner("resume-then-turn-start-error");
    const tool = createCodexReplyTool(runner);

    const result = await tool.handler({ ...defaultReplyInput, threadId: "old-thread" }, asExtra(fakeExtra()));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ threadId: "old-thread", errorText: "turn start failed" });
    expect((result.content[0] as { text: string }).text).toMatch(/turn start failed/);
  });
});
