import { defineConfig } from "vitest/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 5000,
    passWithNoTests: true,
    env: { AI_DELEGATION_TICKET_HELPER: join(mkdtempSync(join(tmpdir(), "no-ticket-helper-")), "missing") },
  },
});
