#!/usr/bin/env node
// stdio entry point: registers `codex` / `codex-reply` on an McpServer, lazily spawning one
// long-lived `codex app-server --stdio` child on the first tool call and respawning it
// automatically (on the next call) if that child ever exits.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AppServerClient, type AppServerClientOptions } from "./app-server-client.js";
import { TurnRunner, type RunTurnOptions, type StartThreadOptions, type ThreadSettings } from "./turn-runner.js";
import { createCodexTool, createCodexReplyTool, type TurnRunnerLike } from "./tools.js";

export interface LazyTurnRunnerOptions {
  // builds a fresh AppServerClient for each spawn. a plain factory (rather than baking the
  // command/args in directly) so tests can point it at tests/fake-app-server.mjs and count spawns.
  createClient: () => AppServerClient;
}

interface Session {
  client: AppServerClient;
  runner: TurnRunner;
}

// a TurnRunnerLike that spawns its underlying AppServerClient + TurnRunner lazily on the first
// call, and transparently respawns a fresh pair the next time it's used after the child exits --
// so one crashed `codex app-server` child doesn't leave the mcp server permanently broken.
export function createLazyTurnRunner(options: LazyTurnRunnerOptions): TurnRunnerLike {
  let session: Session | undefined;
  let spawning: Promise<Session> | undefined;

  function spawn(): Promise<Session> {
    const promise = (async (): Promise<Session> => {
      const client = options.createClient();
      await client.initialize();
      const runner = new TurnRunner(client);
      const next: Session = { client, runner };
      client.onExit(() => {
        // the child died -- drop the cached session so the NEXT call respawns a fresh pair
        // instead of the mcp server staying broken for the rest of the process's life.
        if (session === next) session = undefined;
      });
      session = next;
      return next;
    })();
    spawning = promise;
    void promise.finally(() => {
      if (spawning === promise) spawning = undefined;
    });
    return promise;
  }

  async function getRunner(): Promise<TurnRunner> {
    if (session) return session.runner;
    const active = spawning ?? spawn();
    const next = await active;
    return next.runner;
  }

  return {
    async startThread(startOptions: StartThreadOptions) {
      const runner = await getRunner();
      return runner.startThread(startOptions);
    },
    async ensureThread(threadId: string, fallback: ThreadSettings) {
      const runner = await getRunner();
      return runner.ensureThread(threadId, fallback);
    },
    async runTurn(threadId: string, prompt: string, runOptions?: RunTurnOptions) {
      const runner = await getRunner();
      return runner.runTurn(threadId, prompt, runOptions);
    },
  };
}

function defaultClientOptions(): AppServerClientOptions {
  return { command: process.env.CODEX_BIN ?? "codex", args: ["app-server", "--stdio"] };
}

// package.json is the single source of truth for the version -- read at startup rather than
// duplicated as a literal here, so McpServer's advertised version and this log line can never
// drift out of sync with each other (they used to: this used to be a hardcoded "0.1.0" separate
// from package.json's own version field).
function readOwnVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function main(): Promise<void> {
  const lazyTurnRunner = createLazyTurnRunner({ createClient: () => new AppServerClient(defaultClientOptions()) });

  // a long-lived Node process doesn't hot-reload: once Claude Code spawns this server, it keeps
  // running whatever code was on disk at that moment, even after a later `git pull` + rebuild --
  // confirmed live (2026-09-15) as the actual cause of two field reports of "already-fixed"
  // empty-completion behavior recurring, both from sessions whose codex MCP connection predated
  // the fix. This banner makes that diagnosable at a glance from stderr instead of by inference.
  process.stderr.write(`[codex-app-mcp] starting v${readOwnVersion()} (pid ${process.pid})\n`);

  const server = new McpServer({ name: "codex-app-mcp", version: readOwnVersion() });

  const codexTool = createCodexTool(lazyTurnRunner);
  server.registerTool(codexTool.name, { description: codexTool.description, inputSchema: codexTool.inputSchema }, codexTool.handler);

  const codexReplyTool = createCodexReplyTool(lazyTurnRunner);
  server.registerTool(
    codexReplyTool.name,
    { description: codexReplyTool.description, inputSchema: codexReplyTool.inputSchema },
    codexReplyTool.handler,
  );

  await server.connect(new StdioServerTransport());
}

// only run when executed directly (`node dist/index.js`), not when imported by tests.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[codex-app-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
