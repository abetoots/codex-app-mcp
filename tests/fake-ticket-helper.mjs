#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(join(dirname(process.argv[1]), "tickets.log"), `${input}\n`);
if (process.argv[2] !== "issue") process.exit(1);
const mode = join(dirname(process.argv[1]), "ticket-mode");
if (existsSync(mode)) {
  if (readFileSync(mode, "utf8") === "exit") process.exit(1);
  process.stdout.write("not json");
  process.exit(0);
}
let request;
try { request = JSON.parse(input); } catch { request = null; }
const fields = ["parent_harness", "dispatch_id", "cwd", "add_dirs", "project", "grant_id", "revision", "effective_hash", "expires_at"];
const time = request?.expires_at;
const parsedTime = typeof time === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(time) ? new Date(time) : new Date(NaN);
if (!request || typeof request !== "object" || Array.isArray(request) ||
    Object.keys(request).length !== fields.length || !fields.every((field) => Object.hasOwn(request, field)) ||
    !Array.isArray(request.add_dirs) || ![request.cwd, ...request.add_dirs].every((path) => typeof path === "string" && isAbsolute(path)) ||
    !Number.isFinite(parsedTime.valueOf()) || time.startsWith("0000-") || parsedTime.toISOString().replace(".000Z", "Z") !== time) {
  process.stdout.write(JSON.stringify({ allowed: false, reason: "bad-request" }));
  process.exit(2);
}
process.stdout.write(JSON.stringify({ ticket_id: randomBytes(16).toString("hex") }));
