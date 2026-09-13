// the exact json-rpc payloads codex-app-mcp exchanges with the app-server.
// tests/protocol.test.ts validates each one against the regenerated schema in ./schema.
import { CLIENT_NOTIFICATIONS, CLIENT_REQUESTS, SERVER_REQUESTS } from "../../src/protocol.js";

// requests we send (id is added by the transport)
export const clientRequests = {
  initialize: {
    method: CLIENT_REQUESTS.initialize,
    params: {
      clientInfo: { name: "codex-app-mcp", title: "codex-app-mcp", version: "0.1.0" },
      capabilities: {},
    },
  },
  threadStart: {
    method: CLIENT_REQUESTS.threadStart,
    params: { cwd: "/tmp/x", approvalPolicy: "never", sandbox: "read-only" },
  },
  threadResume: {
    method: CLIENT_REQUESTS.threadResume,
    params: { threadId: "t1", cwd: "/tmp/x", approvalPolicy: "never", sandbox: "read-only" },
  },
  turnStart: {
    method: CLIENT_REQUESTS.turnStart,
    params: { threadId: "t1", input: [{ type: "text", text: "hi" }] },
  },
  turnInterrupt: {
    method: CLIENT_REQUESTS.turnInterrupt,
    params: { threadId: "t1", turnId: "u1" },
  },
} as const;

// notifications we send
export const clientNotifications = {
  initialized: { method: CLIENT_NOTIFICATIONS.initialized },
} as const;

// legacy (v1) approvals use ReviewDecision, whose "denied" variant is an object carrying a reason;
// the plain string form was removed upstream, so the drift test would catch `{decision:"denied"}`
const legacyDenied = {
  decision: { denied: { rejection: "codex-app-mcp runs headless and cannot approve requests" } },
} as const;

// responses we send to server->client requests, keyed by method, with the schema file each must satisfy.
// this server runs headless, so every approval is declined and every prompt gets an empty answer.
export const serverRequestResponses = {
  [SERVER_REQUESTS.commandExecutionApproval]: {
    schema: "CommandExecutionRequestApprovalResponse.json",
    response: { decision: "decline" },
  },
  [SERVER_REQUESTS.fileChangeApproval]: {
    schema: "FileChangeRequestApprovalResponse.json",
    response: { decision: "decline" },
  },
  [SERVER_REQUESTS.permissionsApproval]: {
    schema: "PermissionsRequestApprovalResponse.json",
    response: { permissions: {} },
  },
  [SERVER_REQUESTS.execCommandApproval]: {
    schema: "ExecCommandApprovalResponse.json",
    response: legacyDenied,
  },
  [SERVER_REQUESTS.applyPatchApproval]: {
    schema: "ApplyPatchApprovalResponse.json",
    response: legacyDenied,
  },
  [SERVER_REQUESTS.toolRequestUserInput]: {
    schema: "ToolRequestUserInputResponse.json",
    response: { answers: {} },
  },
  [SERVER_REQUESTS.mcpServerElicitation]: {
    schema: "McpServerElicitationRequestResponse.json",
    response: { action: "decline" },
  },
} as const;
