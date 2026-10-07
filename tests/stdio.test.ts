// exercises the real MCP stdio surface (`node dist/index.js`, spoken to over stdio with the
// actual @modelcontextprotocol/sdk Client + StdioClientTransport), the one layer every other
// test in this repo bypasses -- tools.test.ts and index.test.ts both call tools.ts/index.ts
// functions directly, never through a real MCP transport, so neither exercises zod's
// default-filling (which only happens via McpServer.registerTool's schema conversion) or the
// wire-level JSON-RPC framing itself.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
// CODEX_BIN only overrides the binary path in src/index.ts's defaultClientOptions(); the args
// ["app-server", "--stdio"] are always appended, so the substitute binary must accept (or
// ignore) trailing argv -- confirmed by reading src/index.ts before writing this test. the fake
// server never inspects process.argv, so those two extra args are harmless. it must be directly
// executable (not just a .mjs file passed to `node`), since CODEX_BIN names one command, not a
// command+args pair -- hence the executable bit and shebang on fake-app-server.mjs itself.
const fakeServerPath = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

// dist/index.js is built once, before vitest even starts, by the `pretest` npm lifecycle script
// (see package.json) -- not here. a per-file beforeAll running a blocking `tsc` compile would
// race every other test file vitest runs in parallel, starving them of cpu and risking spurious
// timeouts (see the 2026-09-14 finding B fix commit for the flakiness this used to cause).

describe("real MCP stdio surface (node dist/index.js over stdio)", () => {
  let client: Client | undefined;

  function stdioEnv(scenario: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...process.env, CODEX_BIN: fakeServerPath, FAKE_SCENARIO: scenario, ...extra };
  }

  async function connect(scenario: string, extra: Record<string, string> = {}): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry],
      env: stdioEnv(scenario, extra),
      stderr: "pipe",
    });
    const c = new Client({ name: "stdio-test-client", version: "0.0.0" });
    await c.connect(transport);
    client = c;
    return c;
  }

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("logs a startup banner with its own version to stderr", async () => {
    // a long-lived process doesn't hot-reload after a rebuild -- this banner is the diagnostic
    // for that (confirmed live, 2026-09-15: two field reports of already-fixed behavior
    // recurring, both traced to a stale already-running server process). guards against the
    // banner silently regressing, and against McpServer's advertised version drifting from
    // package.json's (it used to be a separate hardcoded literal).
    const pkgVersion = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"))
      .version as string;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry],
      env: stdioEnv("happy"),
      stderr: "pipe",
    });
    let stderrText = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    const c = new Client({ name: "stdio-test-client", version: "0.0.0" });
    await c.connect(transport);
    client = c;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(stderrText).toContain(`[codex-app-mcp] starting v${pkgVersion} (pid `);
    expect(c.getServerVersion()?.version).toBe(pkgVersion);
  });

  it("mirrors the answer text into structuredContent.content, since some clients drop content when structuredContent is present", async () => {
    // the original codex mcp-server did this deliberately (codex_tool_runner.rs, rust-v0.151.0:
    // "Some MCP clients ignore `content` when `structuredContent` is present, so mirror the
    // text there as well"). claude code is such a client: without the mirror the calling model
    // sees only {threadId, turnId, status} and no answer -- the root cause of every
    // "completed with no text" field report from 2026-09-14 through 2026-10-07.
    const c = await connect("happy");

    const result = await c.callTool({ name: "codex", arguments: { prompt: "hi" } });

    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    expect(result.structuredContent).toMatchObject({ threadId: "t1", content: "pong" });
  });

  it("lists codex and codex-reply with schemas reflecting the documented defaults", async () => {
    const c = await connect("happy");

    const { tools } = await c.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.has("codex")).toBe(true);
    expect(byName.has("codex-reply")).toBe(true);

    const codexSchema = byName.get("codex")!.inputSchema as {
      properties: Record<string, { default?: unknown; enum?: string[] }>;
      required?: string[];
    };
    expect(codexSchema.required).toEqual(["prompt"]);
    expect(codexSchema.properties["approval-policy"].default).toBe("never");
    expect(codexSchema.properties["approval-policy"].enum).toEqual(["untrusted", "on-failure", "on-request", "never"]);
    expect(codexSchema.properties.sandbox.default).toBe("read-only");
    expect(codexSchema.properties.sandbox.enum).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(codexSchema.properties["timeout-seconds"].default).toBe(900);
    expect(codexSchema.properties.profile).toBeDefined();

    const replySchema = byName.get("codex-reply")!.inputSchema as {
      properties: Record<string, { default?: unknown }>;
      required?: string[];
    };
    expect(replySchema.required).toEqual(["prompt"]);
    expect(replySchema.properties.threadId).toBeDefined();
    expect(replySchema.properties.conversationId).toBeDefined();
    expect(replySchema.properties["timeout-seconds"].default).toBe(900);
  });

  it("calls codex over the real transport and returns wire-level content + structuredContent", async () => {
    const c = await connect("happy");

    const result = await c.callTool({ name: "codex", arguments: { prompt: "hi" } });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    expect((result.structuredContent as { threadId?: string }).threadId).toBe("t1");
    expect((result.structuredContent as { status?: string }).status).toBe("completed");
  });

  // performs the MCP handshake and one tool call by hand over a raw child process (rather than
  // through the SDK's Client, which only exposes parsed messages) so every byte the server
  // writes to its own stdout can be inspected -- proving no stray console.log or other
  // non-JSON-RPC output ever lands on the wire, which would corrupt every client's framing.
  it("emits only valid JSON-RPC frames on stdout -- no console.log pollution", async () => {
    const child = spawn(process.execPath, [distEntry], {
      env: stdioEnv("happy"),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

    try {
      await new Promise<void>((resolve, reject) => {
        let buffer = "";
        const responses = new Map<number, unknown>();

        function send(message: Record<string, unknown>): void {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
        }

        child.on("error", reject);
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");
            if (line.trim() === "") continue;
            // a non-JSON-RPC line here (e.g. stray console.log pollution) must not crash the
            // handshake -- it's exactly what the final stdout-wide assertion below is for
            let message: { id?: number };
            try {
              message = JSON.parse(line) as { id?: number };
            } catch {
              continue;
            }
            if (message.id !== undefined) responses.set(message.id, message);

            if (responses.has(1)) {
              // initialize resolved -- complete the handshake, then call a tool
              send({ method: "notifications/initialized" });
              send({ id: 2, method: "tools/call", params: { name: "codex", arguments: { prompt: "hi" } } });
            }
            if (responses.has(2)) {
              resolve();
            }
          }
        });

        send({
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "raw-stdio-test", version: "0.0.0" },
          },
        });
      });
    } finally {
      child.kill();
    }

    const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
    const lines = rawStdout.split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line), `non-JSON line on stdout: ${line}`).not.toThrow();
    }
  });
});
