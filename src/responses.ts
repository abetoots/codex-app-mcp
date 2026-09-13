// canonical responses codex-app-mcp sends back to the app-server for the server-initiated
// requests it recognizes. this server runs headless, so every approval is declined and every
// prompt gets an empty answer.
//
// this is the single source of truth for those literals: tests/fixtures/app-server.ts imports
// them for the schema-drift check in tests/protocol.test.ts, and src/turn-runner.ts imports them
// to answer server requests, so the exact payload only exists in one place.
import { SERVER_REQUESTS, type ServerRequestMethod } from "./protocol.js";

// legacy (v1) approvals use ReviewDecision, whose "denied" variant is an object carrying a
// reason -- the plain string form was removed upstream.
const legacyDenied = {
  decision: { denied: { rejection: "codex-app-mcp runs headless and cannot approve requests" } },
} as const;

// only the methods listed here are recognized/declined by TurnRunner; anything else (including
// item/tool/call, account/chatgptAuthTokens/refresh, attestation/generate, and any future method)
// is left undefined so the caller falls through to AppServerClient's automatic -32601.
export const DECLINE_RESPONSES: Partial<Record<ServerRequestMethod, unknown>> = {
  [SERVER_REQUESTS.commandExecutionApproval]: { decision: "decline" },
  [SERVER_REQUESTS.fileChangeApproval]: { decision: "decline" },
  [SERVER_REQUESTS.permissionsApproval]: { permissions: {} },
  [SERVER_REQUESTS.execCommandApproval]: legacyDenied,
  [SERVER_REQUESTS.applyPatchApproval]: legacyDenied,
  [SERVER_REQUESTS.toolRequestUserInput]: { answers: {} },
  [SERVER_REQUESTS.mcpServerElicitation]: { action: "decline" },
};
