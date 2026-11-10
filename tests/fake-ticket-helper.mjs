#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
process.stdout.write(JSON.stringify({ ticket_id: randomBytes(16).toString("hex") }));
