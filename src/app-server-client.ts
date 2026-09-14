// json-rpc 2.0 client for a spawned `codex app-server --stdio` child process.
//
// frames newline-delimited json-rpc over the child's stdio, correlates our
// requests to their responses, dispatches server notifications and server-
// initiated requests, and fails everything cleanly if the child dies.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { CLIENT_NOTIFICATIONS, CLIENT_REQUESTS } from "./protocol.js";

export interface AppServerClientOptions {
  // defaults to `process.env.CODEX_BIN ?? "codex"` -- override in tests to
  // spawn tests/fake-app-server.mjs instead of the real cli
  command?: string;
  // defaults to ["app-server", "--stdio"]
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

// a jsonrpc error response, e.g. from a request() call the server rejected
export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AppServerRpcError";
    this.code = code;
    this.data = data;
  }
}

// the child process exited (or failed to spawn) while requests were pending
export class AppServerExited extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(exitCode: number | null, signal: NodeJS.Signals | null) {
    super(`app-server exited (code=${String(exitCode)}, signal=${String(signal)})`);
    this.name = "AppServerExited";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
type ExitHandler = (err: AppServerExited) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  // invoked synchronously from settlePending, the instant a matching *successful* response line
  // is parsed -- strictly before `resolve` schedules the promise's .then() callbacks as
  // microtasks. exists so a caller can observe the result before any later, synchronous
  // notification dispatch in the same onStdoutData loop/chunk -- see request()'s doc comment.
  onSettled?: (result: unknown) => void;
}

interface IncomingMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const DEFAULT_ARGS = ["app-server", "--stdio"];

export class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private exited = false;

  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private serverRequestHandler?: ServerRequestHandler;

  private initialized = false;
  // requests made before initialize() resolves wait here; each is either run
  // (handshake succeeded) or rejected with the handshake's own failure
  private queuedBeforeInit: Array<(failure?: Error) => void> = [];

  constructor(options: AppServerClientOptions = {}) {
    const command = options.command ?? process.env.CODEX_BIN ?? "codex";
    const args = options.args ?? DEFAULT_ARGS;

    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[app-server] ${chunk.toString("utf8")}`);
    });
    this.child.on("exit", (code, signal) => this.onChildDown(new AppServerExited(code, signal)));
    this.child.on("error", () => this.onChildDown(new AppServerExited(null, null)));
  }

  // sends `initialize`, awaits its result, then sends `initialized`. requests
  // made via request() before this resolves are queued and flushed here.
  async initialize<T = unknown>(): Promise<T> {
    try {
      const result = await this.sendRequest<T>(CLIENT_REQUESTS.initialize, {
        clientInfo: { name: "codex-app-mcp", title: "codex-app-mcp", version: "0.1.0" },
        capabilities: {},
      });
      this.notify(CLIENT_NOTIFICATIONS.initialized);
      this.initialized = true;
      const queued = this.queuedBeforeInit;
      this.queuedBeforeInit = [];
      for (const flush of queued) flush();
      return result;
    } catch (err) {
      const queued = this.queuedBeforeInit;
      this.queuedBeforeInit = [];
      const failure = err instanceof Error ? err : new Error(String(err));
      for (const flush of queued) flush(failure);
      throw err;
    }
  }

  // sends a request; queues until initialize() has completed the handshake.
  //
  // `onSettled`, when given, is called synchronously the instant a *successful* response for
  // this request is parsed off the wire -- before the returned promise's .then()/await
  // continuations run (those are always deferred to a microtask, even for an already-resolved
  // promise). onStdoutData processes every line in a chunk synchronously and in order, so a
  // notification for this same request's effect (e.g. a turn's own item/completed) can be
  // dispatched later in that same synchronous loop, before any microtask gets a chance to run.
  // anything that must be visible to such same-chunk notification dispatch belongs in
  // `onSettled`, not in a `.then()` on the returned promise. not called on an error response --
  // use .catch()/await+try for that, exactly as before.
  request<T = unknown>(method: string, params?: unknown, onSettled?: (result: T) => void): Promise<T> {
    if (!this.initialized) {
      return new Promise<T>((resolve, reject) => {
        this.queuedBeforeInit.push((failure) => {
          if (failure) {
            reject(failure);
            return;
          }
          this.sendRequest<T>(method, params, onSettled).then(resolve, reject);
        });
      });
    }
    return this.sendRequest<T>(method, params, onSettled);
  }

  // fire-and-forget notification to the app-server
  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  // subscribes to server notifications for `method`; returns an unsubscribe fn
  on(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  // registers the single dispatcher for server-initiated requests. if it
  // returns undefined, throws, or nothing is registered, this client answers
  // with a jsonrpc -32601 error itself so every server request gets a reply.
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  // subscribes to child exit/error; returns an unsubscribe fn
  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  // kills the child process; for callers (tests, shutdown) that need to clean up
  close(): void {
    this.child.kill();
  }

  private sendRequest<T>(method: string, params?: unknown, onSettled?: (result: T) => void): Promise<T> {
    if (this.exited) return Promise.reject(new AppServerExited(null, null));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        onSettled: onSettled as ((result: unknown) => void) | undefined,
      });
      this.write({ id, method, params });
    });
  }

  private write(message: Record<string, unknown>): void {
    if (this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private onStdoutData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
      if (line.trim() === "") continue;

      let message: IncomingMessage;
      try {
        message = JSON.parse(line) as IncomingMessage;
      } catch {
        process.stderr.write(`[app-server-client] malformed json from child, skipping: ${line}\n`);
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: IncomingMessage): void {
    if (typeof message.method === "string" && message.id === undefined) {
      this.dispatchNotification(message.method, message.params);
      return;
    }
    if (typeof message.method === "string" && message.id !== undefined) {
      void this.dispatchServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      this.settlePending(message);
      return;
    }
    process.stderr.write(`[app-server-client] unrecognized message, skipping: ${JSON.stringify(message)}\n`);
  }

  private settlePending(message: IncomingMessage): void {
    const id = message.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) {
      pending.reject(new AppServerRpcError(message.error.code, message.error.message, message.error.data));
    } else {
      // synchronous, and strictly before resolve() -- see onSettled's doc comment on request().
      // this runs inside the child's stdout 'data' handler, so a throw here would otherwise
      // escape as an uncaught exception and crash the whole process instead of just failing
      // this one request -- route it through reject() the same way a bad response would be.
      try {
        pending.onSettled?.(message.result);
      } catch (err) {
        pending.reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      pending.resolve(message.result);
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) return;
    for (const handler of handlers) handler(params);
  }

  private async dispatchServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    let result: unknown;
    let handled = false;
    if (this.serverRequestHandler) {
      try {
        result = await this.serverRequestHandler(method, params);
        handled = result !== undefined;
      } catch {
        handled = false;
      }
    }
    if (handled) {
      this.write({ id, result });
    } else {
      this.write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  private onChildDown(err: AppServerExited): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    for (const handler of this.exitHandlers) handler(err);
  }
}
