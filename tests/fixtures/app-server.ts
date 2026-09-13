// the exact json-rpc payloads codex-app-mcp exchanges with the app-server.
// tests/protocol.test.ts validates each one against the regenerated schema in ./schema.
import { CLIENT_NOTIFICATIONS, CLIENT_REQUESTS, SERVER_REQUESTS } from "../../src/protocol.js";
import { DECLINE_RESPONSES } from "../../src/responses.js";

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

// responses we send to server->client requests, keyed by method, with the schema file each must
// satisfy. the response literals live in src/responses.ts (also used by src/turn-runner.ts) so
// there is exactly one copy of each payload; this fixture only adds the schema filename pairing.
export const serverRequestResponses = {
  [SERVER_REQUESTS.commandExecutionApproval]: {
    schema: "CommandExecutionRequestApprovalResponse.json",
    response: DECLINE_RESPONSES[SERVER_REQUESTS.commandExecutionApproval],
  },
  [SERVER_REQUESTS.fileChangeApproval]: {
    schema: "FileChangeRequestApprovalResponse.json",
    response: DECLINE_RESPONSES[SERVER_REQUESTS.fileChangeApproval],
  },
  [SERVER_REQUESTS.permissionsApproval]: {
    schema: "PermissionsRequestApprovalResponse.json",
    response: DECLINE_RESPONSES[SERVER_REQUESTS.permissionsApproval],
  },
  [SERVER_REQUESTS.execCommandApproval]: {
    schema: "ExecCommandApprovalResponse.json",
    response: DECLINE_RESPONSES[SERVER_REQUESTS.execCommandApproval],
  },
  [SERVER_REQUESTS.applyPatchApproval]: {
    schema: "ApplyPatchApprovalResponse.json",
    response: DECLINE_RESPONSES[SERVER_REQUESTS.applyPatchApproval],
  },
  [SERVER_REQUESTS.toolRequestUserInput]: {
    schema: "ToolRequestUserInputResponse.json",
    response: DECLINE_RESPONSES[SERVER_REQUESTS.toolRequestUserInput],
  },
  [SERVER_REQUESTS.mcpServerElicitation]: {
    schema: "McpServerElicitationRequestResponse.json",
    response: DECLINE_RESPONSES[SERVER_REQUESTS.mcpServerElicitation],
  },
} as const;
