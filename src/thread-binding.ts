// the on-disk record that ties a Codex thread to the project, grant and settings it was started
// with, so codex-reply can resume it after a process restart without trusting the caller.
// knows nothing about MCP or app-server -- src/tools.ts owns when to save and load.
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ThreadSettings } from "./turn-runner.js";

export interface ThreadBinding {
  schema: 1;
  threadId: string;
  cwd: string;
  project: string | null;
  grantId: string | null;
  grantRevision: number | null;
  expiresAt: string | null;
  effectiveHash: string;
  approvalPolicy: ThreadSettings["approvalPolicy"];
  sandbox: ThreadSettings["sandbox"];
  model?: string;
  createdAt: string;
}

// the file is missing its schema, is not json, or does not describe this thread. never carries
// file contents in its message: a binding is not a place for secrets, but an error is no place
// to find out.
export class BindingUnreadable extends Error {
  constructor(threadId: string, reason: string) {
    super(`binding for thread ${threadId} is unreadable: ${reason}`);
    this.name = "BindingUnreadable";
  }
}

// CODEX_MCP_STATE_DIR, else ~/.local/state/codex-app-mcp/bindings
export function defaultBindingDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_MCP_STATE_DIR ?? join(homedir(), ".local", "state", "codex-app-mcp", "bindings");
}

const isStringOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const isNumberOrNull = (v: unknown): boolean => v === null || typeof v === "number";

function validate(threadId: string, value: unknown): ThreadBinding {
  const b = value as Partial<Record<keyof ThreadBinding, unknown>> | null;
  if (typeof b !== "object" || b === null || b.schema !== 1) throw new BindingUnreadable(threadId, "wrong schema");
  const ok =
    b.threadId === threadId &&
    typeof b.cwd === "string" &&
    isStringOrNull(b.project) &&
    isStringOrNull(b.grantId) &&
    isNumberOrNull(b.grantRevision) &&
    isStringOrNull(b.expiresAt) &&
    typeof b.effectiveHash === "string" &&
    typeof b.approvalPolicy === "string" &&
    typeof b.sandbox === "string" &&
    (b.model === undefined || typeof b.model === "string") &&
    typeof b.createdAt === "string";
  if (!ok) throw new BindingUnreadable(threadId, "missing or mistyped fields");
  return b as unknown as ThreadBinding;
}

export class BindingStore {
  constructor(private readonly dir: string) {}

  private fileFor(threadId: string): string {
    return join(this.dir, `${createHash("sha256").update(threadId).digest("hex")}.json`);
  }

  // temp file then rename, so a crash never leaves a half-written binding under the real name
  async save(binding: ThreadBinding): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const file = this.fileFor(binding.threadId);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  async load(threadId: string): Promise<ThreadBinding | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(threadId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new BindingUnreadable(threadId, "cannot be read");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BindingUnreadable(threadId, "not valid json");
    }
    return validate(threadId, parsed);
  }
}
