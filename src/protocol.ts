// the single place listing every codex app-server method name this server depends on.
// tests/protocol.test.ts checks each one against the schema regenerated from the installed cli,
// so a `codex update` that renames anything fails the test suite instead of failing at runtime.

// requests we send to the app-server
export const CLIENT_REQUESTS = {
  initialize: "initialize",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
} as const;

// notifications we send to the app-server
export const CLIENT_NOTIFICATIONS = {
  initialized: "initialized",
} as const;

// notifications the app-server sends that we act on
export const SERVER_NOTIFICATIONS = {
  threadStarted: "thread/started",
  turnStarted: "turn/started",
  itemStarted: "item/started",
  agentMessageDelta: "item/agentMessage/delta",
  itemCompleted: "item/completed",
  turnCompleted: "turn/completed",
  error: "error",
} as const;

// requests the app-server sends to us that we must answer
export const SERVER_REQUESTS = {
  commandExecutionApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  permissionsApproval: "item/permissions/requestApproval",
  execCommandApproval: "execCommandApproval",
  applyPatchApproval: "applyPatchApproval",
  toolRequestUserInput: "item/tool/requestUserInput",
  mcpServerElicitation: "mcpServer/elicitation/request",
  toolCall: "item/tool/call",
  chatgptAuthTokensRefresh: "account/chatgptAuthTokens/refresh",
  attestationGenerate: "attestation/generate",
} as const;

export type ClientRequestMethod = (typeof CLIENT_REQUESTS)[keyof typeof CLIENT_REQUESTS];
export type ClientNotificationMethod = (typeof CLIENT_NOTIFICATIONS)[keyof typeof CLIENT_NOTIFICATIONS];
export type ServerNotificationMethod = (typeof SERVER_NOTIFICATIONS)[keyof typeof SERVER_NOTIFICATIONS];
export type ServerRequestMethod = (typeof SERVER_REQUESTS)[keyof typeof SERVER_REQUESTS];
