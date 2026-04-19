export type {
  HostBridge,
  HostEventListener,
  Subscription,
  SpawnSessionOptions,
  SpawnSessionResult,
  EditorBridge,
  EditorOpenLocation,
  OpenInEditorOptions,
  ShellKind,
  InstallShellIntegrationOptions,
  InstallShellIntegrationReply,
  UninstallShellIntegrationOptions,
  UninstallShellIntegrationReply,
  AiSuggestOptions,
  AiSuggestion,
  AiRiskTier,
  NotifyOptions,
  HostBridgeError,
  HostBridgeErrorCode,
} from './bridge.js';
export { NULL_EDITOR_BRIDGE, AI_SUGGEST_DEFAULT_TIMEOUT_MS } from './bridge.js';

export type { HostCapabilities } from './capabilities.js';
export { DEFAULT_CAPABILITIES } from './capabilities.js';

export type {
  HostEvent,
  HostEventKind,
  SessionId,
  BlockId,
  SpanId,
  EventId,
  SuggestionId,
  DiagnosticId,
  WorkspaceId,
  Producer,
  CwdSource,
  ShellIntegrationStatus,
  SessionEndReason,
  InputKind,
  BoundarySignal,
  BoundaryConfidence,
  OutputStream,
  TruncationReason,
  DetachReason,
  DiagnosticSeverity,
  DiagnosticCategory,
  RiskLevel,
  SuggestionDecision,
  PtyDataEvent,
  PtyExitEvent,
  SessionCreatedEvent,
  SessionCwdChangedEvent,
  SessionShellIntegrationStatusEvent,
  SessionEndedEvent,
  InputSubmittedEvent,
} from './events.js';
export { isEventOfKind } from './events.js';

export { MOCK_PROMPT_STRING, MOCK_PROMPT_BYTES } from './mock-protocol.js';
