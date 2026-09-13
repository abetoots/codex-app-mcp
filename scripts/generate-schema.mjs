// regenerates ./schema from the installed codex cli so tests validate against the real protocol
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "schema");
const bin = process.env.CODEX_BIN ?? "codex";

const result = spawnSync(bin, ["app-server", "generate-json-schema", "--out", outDir], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error(`generate-schema: could not run "${bin}" (${result.error.message}); install the Codex CLI or set CODEX_BIN`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`generate-schema: "${bin} app-server generate-json-schema" exited with ${result.status}`);
  process.exit(result.status ?? 1);
}
if (!existsSync(join(outDir, "ClientRequest.json"))) {
  console.error(`generate-schema: ${outDir}/ClientRequest.json missing after generation`);
  process.exit(1);
}
