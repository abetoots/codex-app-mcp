// exercises the real MCP stdio surface (`node dist/index.js`, spoken to over stdio with the
// actual @modelcontextprotocol/sdk Client + StdioClientTransport), the one layer every other
// test in this repo bypasses -- tools.test.ts and index.test.ts both call tools.ts/index.ts
// functions directly, never through a real MCP transport, so neither exercises zod's
// default-filling (which only happens via McpServer.registerTool's schema conversion) or the
// wire-level JSON-RPC framing itself.
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
// CODEX_BIN only overrides the binary path in src/index.ts's defaultClientOptions(); the args
// ["app-server", "--stdio"] are always appended, so the substitute binary must accept (or
// ignore) trailing argv -- confirmed by reading src/index.ts before writing this test. the fake
// server never inspects process.argv, so those two extra args are harmless. it must be directly
// executable (not just a .mjs file passed to `node`), since CODEX_BIN names one command, not a
// command+args pair -- hence the executable bit and shebang on fake-app-server.mjs itself.
const fakeServerPath = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

beforeAll(() => {
  // always rebuild so dist/index.js reflects the current source -- mirrors bin/smoke.sh's own
  // "build first" rule for anything that spawns the compiled entry point.
  execFileSync("npm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
}, 30_000);

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
