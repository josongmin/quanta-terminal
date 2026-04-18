/**
 * Generated-style TypeScript types mirroring `crates/quanta-proto` events.
 *
 * STAND-IN (hand-authored): this file sits where codegen output will live.
 * When the Rust→TS codegen pipeline ships, this file is overwritten and the
 * shapes below become the single source of truth.
 *
 * Until then, any drift between these and the Rust types is a manual sync.
 * See ADR 0014 §Schema Sharing.
 */

export type SessionId = string;
export type BlockId = string;
export type SpanId = string;
export type DiagnosticId = string;
export type SuggestionId = string;
export type WorkspaceId = string;
export type EventId = string;

export type Producer =
  | 'core'
  | 'pty'
  | 'session'
  | 'block'
  | 'output'
  | 'diagnostic'
  | 'suggestion'
  | 'history'
  | 'security'
  | 'protocol'
  | 'lifecycle';

export interface SchemaVersion {
  readonly major: number;
  readonly minor: number;
}

export interface Envelope<P> {
  readonly event_id: EventId;
  readonly monotonic_seq: number;
  readonly session_id: SessionId;
  readonly block_id?: BlockId;
  readonly wall_clock_ts: string;
  readonly producer_id: Producer;
  readonly schema_version: SchemaVersion;
  readonly causation_id?: EventId;
  readonly payload: P;
}

export type CwdSource = 'launch' | 'osc7' | 'prompt_estimate' | 'unknown' | 'explicit_override';
export type ShellIntegrationStatus = 'installed' | 'missing' | 'partial';
export type BoundarySignal = 'osc133' | 'child_exit' | 'prompt_regex';
export type BoundaryConfidence = 'authoritative' | 'degraded';
export type InputKind = 'shell' | 'intent';
export type OutputStream = 'stdout' | 'stderr';
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

/**
 * Truth-state taxonomy from ADR 0010. Drives badge/banner UI.
 */
export type TruthState =
  | 'authoritative'
  | 'shell_integrated'
  | 'estimated'
  | 'unknown'
  | 'parser_low_confidence'
  | 'detached_after_crash'
  | 'redacted'
  | 'quota_truncated';
