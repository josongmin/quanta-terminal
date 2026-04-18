/**
 * TypeScript mirror of `crates/quanta-proto` event types.
 *
 * STAND-IN: these types are hand-authored pending the codegen pipeline that
 * will generate them from the Rust schema (see ADR 0014, "Schema Sharing").
 * When codegen lands, this file is deleted and replaced by generated output
 * in `packages/ui/src/shared/types/generated/`. For Phase 1 the UI imports
 * these from `@quanta/host-common` for the IPC event surface, and from the
 * generated directory for everything else.
 *
 * Two families of events live here:
 *
 *   1. Core domain events (`session_*`, `block_*`, `output_*`, `input_*`,
 *      `diagnostic_*`, `suggestion_*`, `history_*`) — these mirror the
 *      `crates/quanta-proto/src/events.rs` `Event` enum exactly. That Rust
 *      enum uses `#[serde(tag = "kind", rename_all = "snake_case")]`, so the
 *      discriminator is `kind` and the value is the snake_case of the Rust
 *      variant name. Any future rename on the Rust side is a breaking wire
 *      change and must be mirrored here in the same PR.
 *
 *   2. Phase-1 host-transport events (`pty_data`, `pty_exit`) — these are
 *      synthesized by the host adapter (Tauri topics or VS Code messaging)
 *      and have no Rust `Event` counterpart. They surface raw PTY bytes and
 *      exit state until the real `quanta-core` emits block-boundary-split
 *      `output_chunk` / `block_completed` events over JSON-RPC. They use the
 *      same `kind` discriminator convention (snake_case) so the UI can treat
 *      the entire union uniformly.
 */

export type SessionId = string;
export type BlockId = string;
export type SpanId = string;
export type EventId = string;
export type SuggestionId = string;
export type DiagnosticId = string;
export type WorkspaceId = string;

export type Producer =
  | 'core'
  | 'pty'
  | 'session'
  | 'block'
  | 'output'
  | 'input'
  | 'diagnostic'
  | 'suggestion'
  | 'history'
  | 'security'
  | 'protocol'
  | 'lifecycle';

/* ----- shared enums (mirror Rust) ----- */

export type CwdSource = 'launch' | 'osc7' | 'prompt_estimate' | 'unknown' | 'explicit_override';
export type ShellIntegrationStatus = 'installed' | 'missing' | 'partial';
export type SessionEndReason = 'shell_exited' | 'user_closed' | 'sidecar_shutdown' | 'crash';
export type InputKind = 'shell' | 'intent';
export type BoundarySignal = 'osc133' | 'child_exit' | 'prompt_regex';
export type BoundaryConfidence = 'authoritative' | 'degraded';
export type OutputStream = 'stdout' | 'stderr';
export type TruncationReason = 'per_block_cap' | 'quota_exceeded';
export type DetachReason = 'background_job' | 'sidecar_crash' | 'session_end';
export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export type DiagnosticCategory =
  | 'compiler'
  | 'linter'
  | 'runtime'
  | 'test'
  | 'infra'
  | 'shell'
  | 'unknown';
export type RiskLevel =
  | 'safe_readonly'
  | 'workspace_write'
  | 'system_mutation'
  | 'network_external'
  | 'destructive';
export type SuggestionDecision = 'approved' | 'rejected' | 'edited' | 'canceled';

/* ----- host-transport events (Phase-1 bridge surface only) ----- */

/** Raw PTY output fragment. Emitted by the host adapter, not by `quanta-core`. */
export interface PtyDataEvent {
  readonly kind: 'pty_data';
  readonly sessionId: SessionId;
  readonly seq: number;
  /** Base64-encoded bytes. PTY emits are not guaranteed UTF-8. */
  readonly bytesB64: string;
}

export interface PtyExitEvent {
  readonly kind: 'pty_exit';
  readonly sessionId: SessionId;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/* ----- session events (mirror Rust `SessionCreated` etc.) ----- */

export interface SessionCreatedEvent {
  readonly kind: 'session_created';
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId | null;
  readonly shell: string;
  readonly launchCwd: string;
}

export interface SessionShellIntegrationStatusEvent {
  readonly kind: 'session_shell_integration_status';
  readonly sessionId: SessionId;
  readonly status: ShellIntegrationStatus;
}

export interface SessionCwdChangedEvent {
  readonly kind: 'session_cwd_changed';
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly source: CwdSource;
}

export interface SessionEndedEvent {
  readonly kind: 'session_ended';
  readonly sessionId: SessionId;
  readonly reason: SessionEndReason;
}

/* ----- input event (mirror Rust `InputSubmitted`) ----- */

/**
 * InputSubmitted mirror.
 *
 * Rust-side note: the field `input_kind` is intentionally NOT `kind` because
 * the outer `Event` enum already uses `kind` as its serde tag. Keep this in
 * sync — renaming back to `kind` here breaks JSON parity.
 */
export interface InputSubmittedEvent {
  readonly kind: 'input_submitted';
  readonly sessionId: SessionId;
  readonly text: string;
  readonly inputKind: InputKind;
}

/**
 * Union of events the Phase-1 host bridge may surface. The real engine adds
 * block/output/diagnostic families; those will be appended here as the
 * bridge-surface schema firms up. For now the UI consumes only this subset.
 */
export type HostEvent =
  | PtyDataEvent
  | PtyExitEvent
  | SessionCreatedEvent
  | SessionShellIntegrationStatusEvent
  | SessionCwdChangedEvent
  | SessionEndedEvent
  | InputSubmittedEvent;

export type HostEventKind = HostEvent['kind'];

/** Narrow a HostEvent to a specific kind. Useful for TS control flow. */
export function isEventOfKind<K extends HostEventKind>(
  event: HostEvent,
  kind: K,
): event is Extract<HostEvent, { kind: K }> {
  return event.kind === kind;
}
