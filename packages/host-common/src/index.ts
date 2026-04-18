export type {
  HostBridge,
  HostEventListener,
  Subscription,
  SpawnSessionOptions,
  SpawnSessionResult,
  EditorBridge,
  EditorOpenLocation,
} from './bridge.js';
export { NULL_EDITOR_BRIDGE } from './bridge.js';

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
