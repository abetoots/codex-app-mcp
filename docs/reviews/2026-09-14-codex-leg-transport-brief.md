# Review brief: transport decision for the Codex leg of a multi-model workflow

You are one reviewer on a panel. Analyze only; DO NOT modify, create, or delete any files.

## Context
A Claude Code setup drives OpenAI Codex as an external "leg" through an MCP server registered
as `codex` with tools `codex` and `codex-reply`. That server was `codex mcp-server`, which
OpenAI removed from the Codex CLI (installed version: codex-cli 0.154.0). The leg is down.

Three options are on the table:
- A. Build a thin stdio MCP server (Node/TypeScript) that wraps `codex app-server` JSON-RPC and
  re-exposes the old `codex` / `codex-reply` tools with the old parameter names. (Recommended by the lead.)
- B. Adopt the official Claude Code plugin https://github.com/openai/codex-plugin-cc.
- C. Adopt a community wrapper such as `@kvokka/codex-mcp` (app-server based, requires Bun) or
  `@trishchuk/codex-mcp-tool` (`codex exec` based).

## Read these files (absolute paths)
1. /home/anon/tmp-create-codex-mcp/docs/research/2026-09-14-codex-mcp-replacement.md  (research report with citations and local probe evidence)
2. /home/anon/tmp-create-codex-mcp/docs/plans/codex-app-mcp/strategic-plan.md
3. /home/anon/tmp-create-codex-mcp/docs/plans/codex-app-mcp/phase-1-mvp-server.md

## Your task
1. Decide: A, B, or C (or a variant), with reasons.
2. Attack the lead's premises. In particular verify independently, with your own tools:
   - that `codex mcp-server` is really gone and `codex app-server` is the documented successor
     (https://learn.chatgpt.com/docs/mcp-server , https://learn.chatgpt.com/docs/app-server);
   - that `openai/codex-plugin-cc` exposes no MCP tools (only slash commands + a subagent);
   - whether any official or community option the lead missed would make option A unnecessary;
   - whether the phase-1 tool contract and protocol mapping are correct for app-server on 0.154.0
     (you may run `codex app-server generate-json-schema --out <tmpdir>` or read the schema at
     /tmp/claude-1000/-home-anon-tmp-create-codex-mcp/9227c194-14aa-4a2c-82f0-f8292a3a51ee/scratchpad/schema/ if accessible).
3. Review the phase-1 plan for design flaws: process model, thread continuation after child
   restart, approval handling, timeouts inside an MCP client, env/secret propagation, test strategy.

## Assume parity
The lead ran a deep-research procedure (multi-source web research with full-page reads) and
local probes. Invoke your own equivalent: your `deep-research` skill/plugin if you have one, or
web search + fetching the primary pages. If you cannot access the web, say so plainly and name
what you used instead.

## Verdict protocol (mandatory)
A bare GO / APPROVED / "looks good" is non-responsive. Return EITHER concrete blockers, each with
a severity (high / medium / low), OR an explicit falsifier: the single most likely thing that,
if true, breaks the recommendation. You may return both.

## Provenance (mandatory)
State plainly what you actually ran or fetched versus what you answered from memory. Mark any
currency claim you did not verify as "unverified".

## Output format (target 500–900 words)
- Verdict: GO-A | GO-B | GO-C | NO-GO, one line.
- Blockers: numbered, each with severity and the file/section it applies to.
- Falsifier: one paragraph.
- Missed options: list or "none found".
- Plan corrections: numbered, concrete.
- Provenance: what you ran / fetched / answered from memory.
