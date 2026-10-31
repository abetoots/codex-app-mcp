// thread bindings end to end: the binding store, the grant client, and the codex / codex-reply
// tools over a real TurnRunner + tests/fake-app-server.mjs ("binding-log" scenario) and a fake
// grant checker (tests/fake-grant-check.mjs). "restart" means a brand new AppServerClient,
// TurnRunner and tool objects over the same on-disk store; the one test that kills a real
// server process spawns the built dist/index.js.
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { AppServerClient } from "../src/app-server-client.js";
import { GrantClient, fromWire, toWire, type GrantRequest } from "../src/grant-client.js";
import { BindingStore, BindingUnreadable, type ThreadBinding } from "../src/thread-binding.js";
import { createCodexReplyTool, createCodexTool } from "../src/tools.js";
import { TurnRunner } from "../src/turn-runner.js";

const fakeServerPath = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));
const fakeCheckerSource = fileURLToPath(new URL("./fake-grant-check.mjs", import.meta.url));
const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

interface Env {
  dir: string;
  cwd: string;
  stateDir: string;
  checker: string;
  logFile: string;
  requestsLog: string;
  store: BindingStore;
  grants: GrantClient;
}

function wireDecision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowed: true,
    reason: "standing-scope",
    project: "p1",
    grant_revision: null,
    expires_at: null,
    roots: ["/r"],
    effective_hash: "h1",
    ...over,
  };
}

function granted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return wireDecision({ reason: "granted", grant_revision: 1, expires_at: "2099-01-01T00:00:00Z", ...over });
}

function denied(reason: string): Record<string, unknown> {
  return wireDecision({ allowed: false, reason });
}

function makeEnv(fixture: Record<string, unknown> = { decision: wireDecision() }): Env {
  const dir = mkdtempSync(join(tmpdir(), "binding-test-"));
  const cwd = join(dir, "proj");
  mkdirSync(cwd);
  const checker = join(dir, "grant-check.mjs");
  copyFileSync(fakeCheckerSource, checker);
  chmodSync(checker, 0o755);
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  const stateDir = join(dir, "bindings");
  return {
    dir,
    cwd: realpathSync(cwd),
    stateDir,
    checker,
    logFile: join(dir, "app-server.log"),
    requestsLog: join(dir, "requests.log"),
    store: new BindingStore(stateDir),
    grants: new GrantClient(checker),
  };
}

function setFixture(env: Env, fixture: Record<string, unknown>): void {
  writeFileSync(join(env.dir, "fixture.json"), JSON.stringify(fixture));
}

function lines(path: string): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function calls(env: Env, method: string): Array<Record<string, any>> {
  return lines(env.logFile).filter((l) => l.method === method);
}

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const clients: AppServerClient[] = [];
const mcpClients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const c of mcpClients.splice(0)) await c.close();
  vi.restoreAllMocks();
});

// a fresh app-server child + runner + tools over env's store: calling it again is a "restart"
async function boot(env: Env) {
  const client = new AppServerClient({
    command: process.execPath,
    args: [fakeServerPath],
    env: { ...process.env, FAKE_SCENARIO: "binding-log", FAKE_LOG: env.logFile },
  });
  clients.push(client);
  await client.initialize();
  const runner = new TurnRunner(client);
  // a fresh store each boot, so nothing but the files on disk survives a restart
  const deps = { bindings: new BindingStore(env.stateDir), grants: env.grants };
  return { codex: createCodexTool(runner, deps), reply: createCodexReplyTool(runner, deps) };
}

const extra = { _meta: undefined, sendNotification: vi.fn(async () => {}) } as any;

const codexInput = {
  prompt: "hi",
  model: undefined,
  effort: undefined,
  profile: undefined,
  cwd: undefined,
  grant: undefined,
  "approval-policy": "never" as const,
  sandbox: "read-only" as const,
  config: undefined,
  "base-instructions": undefined,
  "developer-instructions": undefined,
  "compact-prompt": undefined,
  "timeout-seconds": 900,
};

const replyInput = {
  prompt: "again",
  model: undefined,
  effort: undefined,
  cwd: undefined,
  "timeout-seconds": 900,
};

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? "").join("\n");

describe("BindingStore", () => {
  const binding = (threadId: string): ThreadBinding => ({
    schema: 1,
    threadId,
    cwd: "/x",
    project: "p1",
    grantId: null,
    grantRevision: null,
    expiresAt: null,
    effectiveHash: "h1",
    approvalPolicy: "never",
    sandbox: "read-only",
    createdAt: "2026-10-28T00:00:00Z",
  });

  it("round-trips a binding in sha256(threadId).json, directory 0700, file 0600", async () => {
    const env = makeEnv();
    await env.store.save(binding("t1"));

    expect(await env.store.load("t1")).toEqual(binding("t1"));
    const file = join(env.stateDir, `${createHash("sha256").update("t1").digest("hex")}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(env.stateDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(env.stateDir)).toEqual([`${createHash("sha256").update("t1").digest("hex")}.json`]);
  });

  it("returns undefined for a thread with no file, and throws BindingUnreadable for corrupt or wrong-schema files", async () => {
    const env = makeEnv();
    expect(await env.store.load("nope")).toBeUndefined();

    await env.store.save(binding("t1"));
    const file = join(env.stateDir, `${createHash("sha256").update("t1").digest("hex")}.json`);
    writeFileSync(file, "{not json");
    await expect(env.store.load("t1")).rejects.toBeInstanceOf(BindingUnreadable);
    writeFileSync(file, JSON.stringify({ ...binding("t1"), schema: 2 }));
    await expect(env.store.load("t1")).rejects.toBeInstanceOf(BindingUnreadable);
  });
});

describe("BindingStore field validation", () => {
  const good = {
    schema: 1, threadId: "t1", cwd: "/x", project: "p1", grantId: "g1", grantRevision: 1, expiresAt: null,
    effectiveHash: "h1", approvalPolicy: "never", sandbox: "read-only", model: "mA", createdAt: "2026-10-28T00:00:00Z",
  };

  it.each<[string, Record<string, unknown>]>([
    ["approvalPolicy typo", { approvalPolicy: "never-typo" }],
    ["approvalPolicy on-failure (never stored)", { approvalPolicy: "on-failure" }],
    ["sandbox typo", { sandbox: "read-onyl" }],
    ["cwd number", { cwd: 42 }],
    ["relative cwd", { cwd: "proj" }],
    ["project number", { project: 7 }],
    ["grantId number", { grantId: 7 }],
    ["grantRevision string", { grantRevision: "1" }],
    ["grantRevision fractional", { grantRevision: 1.5 }],
    ["expiresAt number", { expiresAt: 5 }],
    ["effectiveHash null", { effectiveHash: null }],
    ["model number", { model: 3 }],
    ["createdAt number", { createdAt: 1 }],
    ["another thread's id", { threadId: "t2" }],
  ])("a valid-json binding with %s is unreadable", async (_name, over) => {
    const env = makeEnv();
    await env.store.save(good as unknown as ThreadBinding);
    const file = join(env.stateDir, `${createHash("sha256").update("t1").digest("hex")}.json`);
    writeFileSync(file, JSON.stringify({ ...good, ...over }));
    await expect(env.store.load("t1")).rejects.toBeInstanceOf(BindingUnreadable);
  });

  it("a malformed binding refuses the reply before thread/resume", async () => {
    const env = makeEnv();
    await (await boot(env)).codex.handler({ ...codexInput, cwd: env.cwd }, extra);
    const [file] = readdirSync(env.stateDir);
    const path = join(env.stateDir, file);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), approvalPolicy: "never-typo", sandbox: "read-onyl" }));
    const { reply } = await boot(env);

    const result = await reply.handler({ ...replyInput, threadId: "t1" }, extra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no readable binding/);
    expect(calls(env, "thread/resume")).toHaveLength(0);
    expect(calls(env, "turn/start")).toHaveLength(1);
  });
});

describe("GrantClient", () => {
  const req: GrantRequest = {
    phase: "resume",
    harness: "codex",
    cwd: "/x",
    addDirs: [],
    grantId: "g1",
    revision: 3,
    boundProject: "p1",
  };

  it("sends the snake_case wire request and parses the camelCase decision", async () => {
    const env = makeEnv({ decision: granted() });
    const decision = await env.grants.check(req);

    expect(lines(env.requestsLog)).toEqual([
      { phase: "resume", harness: "codex", cwd: "/x", add_dirs: [], grant_id: "g1", revision: 3, bound_project: "p1" },
    ]);
    expect(decision).toEqual({
      allowed: true,
      reason: "granted",
      project: "p1",
      grantRevision: 1,
      expiresAt: "2099-01-01T00:00:00Z",
      roots: ["/r"],
      effectiveHash: "h1",
    });
    expect(toWire(req).bound_project).toBe("p1");
    expect(fromWire(denied("revoked")).allowed).toBe(false);
  });

  it("returns a denial (exit 2) as a decision, and rejects when the checker is unreadable (exit 3) or missing", async () => {
    const env = makeEnv({ decision: denied("revoked") });
    expect((await env.grants.check(req)).reason).toBe("revoked");

    setFixture(env, { exit: 3 });
    await expect(env.grants.check(req)).rejects.toThrow(/exited 3.*unscoped test server.*run bin\/plan to see why/);
    await expect(new GrantClient(join(env.dir, "absent")).check(req)).rejects.toThrow();
  });
});

describe("GrantClient contract", () => {
  const req: GrantRequest = { phase: "start", harness: "codex", cwd: "/x", addDirs: [], grantId: null, revision: null, boundProject: null };

  it("exit 2 with allowed:true is a denial, not an allow", async () => {
    const env = makeEnv({ decision: wireDecision(), exitWith: 2 });
    const decision = await env.grants.check(req).catch(() => undefined);
    expect(decision?.allowed ?? false).toBe(false);
  });

  it("a checker that cannot run, or exits 1, rejects and never allows", async () => {
    const env = makeEnv({ decision: wireDecision(), exitWith: 1 });
    await expect(env.grants.check(req)).rejects.toThrow(/exited 1/);
    await expect(new GrantClient(join(env.dir, "absent")).check(req)).rejects.toThrow(/could not run/);
  });

  it("malformed stdout is refused with a fixed message that never echoes the output", async () => {
    const env = makeEnv({ rawStdout: "S3CR3T-not-json" });
    const { codex } = await boot(env);
    const errors = vi.spyOn(console, "error");

    const result = await codex.handler({ ...codexInput, cwd: env.cwd }, extra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/grant check failed/);
    expect(JSON.stringify([result, errors.mock.calls])).not.toContain("S3CR3T");
    expect(calls(env, "thread/start")).toHaveLength(0);
    await expect(env.grants.check(req)).rejects.toThrow(/unreadable output/);
    await env.grants.check(req).catch((e: Error) => expect(e.message).not.toContain("S3CR3T"));
  });
});

describe("codex thread binding", () => {
  it("codex outside any project without a grant works and stores a binding", async () => {
    const env = makeEnv({ decision: wireDecision({ reason: "no-project", project: null, effective_hash: "h0" }) });
    const { codex } = await boot(env);

    const result = await codex.handler({ ...codexInput, cwd: env.cwd, model: "mA", "approval-policy": "on-request" }, extra);

    expect(result.isError).toBeFalsy();
    const b = await env.store.load("t1");
    expect(b).toMatchObject({
      schema: 1,
      threadId: "t1",
      cwd: env.cwd,
      project: null,
      grantId: null,
      grantRevision: null,
      effectiveHash: "h0",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      model: "mA",
    });
    expect(lines(env.requestsLog)[0]).toMatchObject({ phase: "start", harness: "codex", cwd: env.cwd, grant_id: null });
  });

  it("without a cwd the thread is bound to the launch directory's real path", async () => {
    const env = makeEnv();
    const { codex } = await boot(env);

    await codex.handler({ ...codexInput, cwd: undefined }, extra);

    const launchDir = realpathSync(process.cwd());
    expect(calls(env, "thread/start")[0].params.cwd).toBe(launchDir);
    expect((await env.store.load("t1"))?.cwd).toBe(launchDir);
    expect(lines(env.requestsLog)[0].cwd).toBe(launchDir);
  });

  it("two threads never overwrite each other's binding", async () => {
    const env = makeEnv();
    const { codex } = await boot(env);

    await codex.handler({ ...codexInput, cwd: env.cwd, model: "mA" }, extra);
    await codex.handler({ ...codexInput, cwd: env.cwd, model: "mB", sandbox: "workspace-write" }, extra);

    expect(await env.store.load("t1")).toMatchObject({ threadId: "t1", model: "mA", sandbox: "read-only" });
    expect(await env.store.load("t2")).toMatchObject({ threadId: "t2", model: "mB", sandbox: "workspace-write" });
  });

  it("a failed binding save returns an error and the thread is never used", async () => {
    const env = makeEnv();
    writeFileSync(env.stateDir, "i am a file, not a directory");
    const { codex } = await boot(env);

    const result = await codex.handler({ ...codexInput, cwd: env.cwd }, extra);

    expect(result.isError).toBe(true);
    expect(calls(env, "turn/start")).toHaveLength(0);
  });

  it("codex with any caller config is refused before thread/start", async () => {
    const env = makeEnv();
    const { codex } = await boot(env);
    const stderr = vi.spyOn(process.stderr, "write");
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m));

    const result = await codex.handler({ ...codexInput, cwd: env.cwd, config: { token: "S3CR3T" } }, extra);

    expect(result.isError).toBe(true);
    expect(calls(env, "thread/start")).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("S3CR3T");
    expect(textOf(result)).toMatch(/config/);
    expect(JSON.stringify([...stderr.mock.calls, ...spies.flatMap((s) => s.mock.calls)])).not.toContain("S3CR3T");
    for (const name of readdirSync(env.dir, { recursive: true, encoding: "utf8" })) {
      const path = join(env.dir, name);
      if (statSync(path).isFile()) expect(readFileSync(path, "utf8")).not.toContain("S3CR3T");
    }
  });

  it("codex is refused when the start check denies", async () => {
    // resume is allowed on purpose: the first-turn recheck must not be what stops the call
    const env = makeEnv({ byPhase: { start: denied("outside-roots"), resume: wireDecision() } });
    const { codex } = await boot(env);

    const result = await codex.handler({ ...codexInput, cwd: env.cwd }, extra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("outside-roots");
    expect(calls(env, "thread/start")).toHaveLength(0);
    expect(calls(env, "turn/start")).toHaveLength(0);
    expect(existsSync(env.stateDir) ? readdirSync(env.stateDir) : []).toEqual([]);
    expect(lines(env.requestsLog)).toHaveLength(1);
  });
});

describe("codex first-turn recheck", () => {
  it("the start check carries the caller's grant", async () => {
    const env = makeEnv({ decision: granted() });
    const { codex } = await boot(env);
    await codex.handler({ ...codexInput, cwd: env.cwd, grant: "g1" }, extra);

    expect(lines(env.requestsLog)[0]).toEqual({
      phase: "start", harness: "codex", cwd: env.cwd, add_dirs: [], grant_id: "g1", revision: null, bound_project: null,
    });
  });

  it.each([
    ["the project mapping changed", "project-changed"],
    ["the grant was revoked", "revoked"],
  ])("refuses the first turn when %s between start and first turn", async (_name, reason) => {
    const env = makeEnv({ byPhase: { start: granted(), resume: denied(reason) } });
    const { codex } = await boot(env);

    const result = await codex.handler({ ...codexInput, cwd: env.cwd, grant: "g1" }, extra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(reason);
    expect(calls(env, "turn/start")).toHaveLength(0);
    // the recheck is a resume check on the just-saved binding's project, grant and revision
    expect(lines(env.requestsLog)[1]).toMatchObject({ phase: "resume", grant_id: "g1", revision: 1, bound_project: "p1", cwd: env.cwd });
  });

  it("refuses the first turn when the standing scope fingerprint changed", async () => {
    const env = makeEnv({ sequence: [wireDecision(), wireDecision({ effective_hash: "h2" })] });
    const { codex } = await boot(env);

    const result = await codex.handler({ ...codexInput, cwd: env.cwd }, extra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/standing scope changed/);
    expect(calls(env, "turn/start")).toHaveLength(0);
  });

  it("a checker that cannot run refuses codex and codex-reply", async () => {
    const env = makeEnv();
    await (await boot(env)).codex.handler({ ...codexInput, cwd: env.cwd }, extra);
    setFixture(env, { exit: 3 });
    const restarted = await boot(env);

    const replied = await restarted.reply.handler({ ...replyInput, threadId: "t1" }, extra);
    const started = await restarted.codex.handler({ ...codexInput, cwd: env.cwd }, extra);

    expect(replied.isError).toBe(true);
    expect(textOf(replied)).toMatch(/grant check failed/);
    expect(calls(env, "thread/resume")).toHaveLength(0);
    expect(started.isError).toBe(true);
    expect(calls(env, "thread/start")).toHaveLength(1);
  });
});

describe("codex-reply thread binding", () => {
  it("reply with no binding after restart is refused", async () => {
    const env = makeEnv();
    const { reply } = await boot(env);

    const result = await reply.handler({ ...replyInput, threadId: "t-unknown" }, extra);

    expect(result.isError).toBe(true);
    expect(calls(env, "thread/resume")).toHaveLength(0);
    expect(calls(env, "turn/start")).toHaveLength(0);
  });

  it("a corrupt binding file refuses the reply", async () => {
    const env = makeEnv();
    await (await boot(env)).codex.handler({ ...codexInput, cwd: env.cwd }, extra);
    const [file] = readdirSync(env.stateDir);
    writeFileSync(join(env.stateDir, file), "{corrupt");
    const { reply } = await boot(env);

    const result = await reply.handler({ ...replyInput, threadId: "t1" }, extra);

    expect(result.isError).toBe(true);
    expect(calls(env, "thread/resume")).toHaveLength(0);
    expect(calls(env, "turn/start")).toHaveLength(1);
  });

  it("reply with a different cwd is refused", async () => {
    const env = makeEnv();
    await (await boot(env)).codex.handler({ ...codexInput, cwd: env.cwd }, extra);
    const other = join(env.dir, "other");
    mkdirSync(other);
    const { reply } = await boot(env);

    const result = await reply.handler({ ...replyInput, threadId: "t1", cwd: other }, extra);

    expect(result.isError).toBe(true);
    expect(calls(env, "thread/resume")).toHaveLength(0);
    expect(calls(env, "turn/start")).toHaveLength(1);
  });

  it.each([
    ["reply after revoke is refused", "revoked"],
    ["reply after expiry is refused", "expired"],
    ["reply after the grant revision changed is refused", "revision-changed"],
    ["reply after the project mapping changed is refused", "project-changed"],
  ])("%s", async (_name, reason) => {
    const env = makeEnv({ decision: granted() });
    await (await boot(env)).codex.handler({ ...codexInput, cwd: env.cwd, grant: "g1" }, extra);
    setFixture(env, { byPhase: { start: granted(), resume: denied(reason) } });
    const { reply } = await boot(env);

    const result = await reply.handler({ ...replyInput, threadId: "t1" }, extra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(reason);
    expect(calls(env, "thread/resume")).toHaveLength(0);
    expect(calls(env, "turn/start")).toHaveLength(1);
    // the resume check carries the bound project, grant and revision (the first resume line is
    // codex's own first-turn recheck)
    expect(lines(env.requestsLog).filter((r) => r.phase === "resume")[1]).toMatchObject({
      grant_id: "g1",
      revision: 1,
      bound_project: "p1",
      cwd: env.cwd,
    });
  });

  it("reply after the standing scope changed is refused", async () => {
    // calls 0,1: start check and its beforeStart recheck; 2: reply handler; 3: reply beforeStart
    const env = makeEnv({ sequence: [wireDecision(), wireDecision(), wireDecision(), wireDecision({ effective_hash: "h2" })] });
    const { codex, reply } = await boot(env);
    await codex.handler({ ...codexInput, cwd: env.cwd }, extra);

    const result = await reply.handler({ ...replyInput, threadId: "t1" }, extra);

    expect(result.isError).toBe(true);
    expect(calls(env, "turn/start")).toHaveLength(1);
  });

  it("reply refused when the handler check already sees a different standing scope", async () => {
    const env = makeEnv({ sequence: [wireDecision(), wireDecision(), wireDecision({ effective_hash: "h2" })] });
    const { codex, reply } = await boot(env);
    await codex.handler({ ...codexInput, cwd: env.cwd }, extra);

    const result = await reply.handler({ ...replyInput, threadId: "t1" }, extra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/standing scope changed/);
    expect(calls(env, "turn/start")).toHaveLength(1);
  });

  it.each([
    ["without a restart", false],
    ["after a restart", true],
  ])("revalidates after queue wait, not before it (%s)", async (_name, restart) => {
    const env = makeEnv({ byPhase: { start: granted(), resume: granted() } });
    const first0 = await boot(env);
    await first0.codex.handler({ ...codexInput, cwd: env.cwd, grant: "g1" }, extra);
    const { reply } = restart ? await boot(env) : first0;

    const first = reply.handler({ ...replyInput, threadId: "t1", prompt: "hold one" }, extra);
    await waitFor(() => calls(env, "turn/start").length === 2, "first reply turn");
    const second = reply.handler({ ...replyInput, threadId: "t1", prompt: "second" }, extra);
    // start (2 checks) + first reply (2) + second reply's handler check
    await waitFor(() => lines(env.requestsLog).length === 5, "second reply's handler check");
    // nothing is checked while the second reply sits in the queue
    await new Promise((r) => setTimeout(r, 300));
    expect(lines(env.requestsLog)).toHaveLength(5);
    setFixture(env, { byPhase: { start: granted(), resume: denied("revoked") } });
    writeFileSync(`${env.logFile}.release`, "");

    expect((await first).isError).toBeFalsy();
    const refused = await second;
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("revoked");
    expect(lines(env.requestsLog)).toHaveLength(6);
    expect(calls(env, "turn/start")).toHaveLength(2);
    if (restart) expect(calls(env, "thread/resume")).toHaveLength(1);
  });

  it("a model changed by a reply survives a restart", async () => {
    const env = makeEnv();
    await (await boot(env)).codex.handler({ ...codexInput, cwd: env.cwd, model: "mA" }, extra);
    const second = await boot(env);
    expect((await second.reply.handler({ ...replyInput, threadId: "t1", model: "mB" }, extra)).isError).toBeFalsy();
    const file = join(env.stateDir, `${createHash("sha256").update("t1").digest("hex")}.json`);
    expect(JSON.parse(readFileSync(file, "utf8")).model).toBe("mB");

    const { reply } = await boot(env);
    const result = await reply.handler({ ...replyInput, threadId: "t1" }, extra);

    expect(result.isError).toBeFalsy();
    const resumes = calls(env, "thread/resume");
    expect(resumes[resumes.length - 1].params.model).toBe("mB");
  });

  it("a rejected model change is not persisted", async () => {
    const env = makeEnv();
    await (await boot(env)).codex.handler({ ...codexInput, cwd: env.cwd, model: "mA" }, extra);
    const second = await boot(env);
    const rejected = await second.reply.handler({ ...replyInput, threadId: "t1", model: "m1", effort: "turbo" }, extra);
    expect(rejected.isError).toBe(true);

    expect((await env.store.load("t1"))?.model).toBe("mA");
    const { reply } = await boot(env);
    await reply.handler({ ...replyInput, threadId: "t1" }, extra);
    const resumes = calls(env, "thread/resume");
    expect(resumes[resumes.length - 1].params.model).toBe("mA");
  });

  it("reply after the server is SIGKILLed mid-turn resumes from disk with the stored cwd, approval, sandbox and model", async () => {
    const env = makeEnv();
    const connect = async (): Promise<{ client: Client; transport: StdioClientTransport }> => {
      const client = new Client({ name: "binding-test", version: "0.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [distEntry],
        env: {
          ...process.env,
          CODEX_BIN: fakeServerPath,
          FAKE_SCENARIO: "binding-log",
          FAKE_LOG: env.logFile,
          AI_GRANT_CHECK: env.checker,
          CODEX_MCP_STATE_DIR: env.stateDir,
        },
        stderr: "pipe",
      });
      await client.connect(transport);
      mcpClients.push(client);
      return { client, transport };
    };

    const first = await connect();
    const inFlight = first.client
      .callTool({
        name: "codex",
        arguments: { prompt: "slow hi", model: "mA", "approval-policy": "on-request", sandbox: "workspace-write", cwd: env.cwd },
      })
      .catch(() => undefined);
    await waitFor(() => calls(env, "turn/start").length === 1, "the first turn to be in flight");
    process.kill(first.transport.pid as number, "SIGKILL");
    await inFlight;

    const second = await connect();
    const replied = await second.client.callTool({ name: "codex-reply", arguments: { threadId: "t1", prompt: "again" } });

    expect(replied.isError).toBeFalsy();
    expect(calls(env, "thread/resume")[0].params).toMatchObject({
      threadId: "t1",
      cwd: env.cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "mA",
    });
  });
});
