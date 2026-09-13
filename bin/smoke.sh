#!/usr/bin/env bash
set -euo pipefail

# run this after `codex update` to catch app-server protocol drift

# resolve the project root relative to this script's own location, so it works from anywhere
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
project_root="$(cd -- "${script_dir}/.." >/dev/null 2>&1 && pwd -P)"
cd "${project_root}"

# tests/live.smoke.test.ts imports from ../src/*.ts (vitest's native ts support), so the build
# isn't strictly required for the smoke test itself -- but building anyway catches a broken
# `dist/` (what actually ships) before the live protocol check runs.
npm run build

CODEX_LIVE=1 npx vitest run tests/live.smoke.test.ts
