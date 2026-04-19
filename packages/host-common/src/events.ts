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
  | 'lifecycle'
  | 'grid';

/* ----- shared enums (mirror Rust) ----- */

export type CwdSource = 'launch' | 'osc7' | 'prompt_estimate' | 'unknown' | 'explicit_override';
export type ShellIntegrationStatus = 'installed' | 'missing' | 'partial';
export type SessionEndReason =
  | 'shell_exited'
  | 'user_closed'
  | 'sidecar_shutdown'
  | 'crash'
  | 'sink_failure';
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

/* ----- grid-reducer events (EPIC-C; mirror Rust `Event::Grid*`) ----- */

/** Which terminal buffer an envelope / snapshot applies to. */
export type BufferKind = 'main' | 'alt';

export type CursorShape = 'block' | 'underline' | 'bar';

export type TitleScope = 'both' | 'icon' | 'window';

export type BellKind = 'audible' | 'visual' | 'urgency_hint';

export type ClipboardSelection = 'clipboard' | 'primary' | 'secondary' | 'select';

export type MouseTrackingMode = 'off' | 'x10' | 'button_event' | 'any_event';

export type MouseEncoding = 'default' | 'utf8' | 'sgr' | 'url_xterm';

export type SyncPhase = 'begin' | 'end';

/** OSC 52 op: set with base64 data or query. Discriminated via `op`. */
export type ClipboardOp =
  | { readonly op: 'set'; readonly base64_data: string }
  | { readonly op: 'query' };

/** Grapheme-run encoding inside a `CellSpan`. Matches Rust `GraphemeRunWire`. */
export type GraphemeRun =
  | 'blank'
  | { readonly utf8: string | readonly number[] }
  | { readonly grapheme: string; readonly count: number };

/** Extension map for SGR attrs that don't fit in the u64. */
export interface SpanAttrsExt {
  readonly underline_color?: number | null;
}

/** A run of cells sharing SGR attrs. */
export interface CellSpan {
  readonly cols: number;
  readonly sgr: string;
  readonly graphemes: GraphemeRun;
  readonly hyperlink_id?: number;
  readonly ext?: SpanAttrsExt | null;
}

/** Per-row replacement content. */
export interface RowDelta {
  readonly row: number;
  readonly revision_before: number;
  readonly revision_after: number;
  readonly spans: readonly CellSpan[];
  readonly continuation?: boolean;
  readonly hyperlink_refs?: readonly number[];
}

/** Rectangular scroll op. */
export interface ScrollDelta {
  readonly top: number;
  readonly bottom: number;
  readonly lines: number;
  readonly left?: number;
  readonly right?: number | null;
}

/** Cursor wire state. */
export interface CursorState {
  readonly row: number;
  readonly col: number;
  readonly visible: boolean;
  readonly shape: CursorShape;
  readonly blinking: boolean;
  readonly pending_wrap?: boolean;
}

/** Terminal mode snapshot mirror (ADR 0017 §4). */
export interface TerminalModeState {
  readonly decckm?: boolean;
  readonly bracketed_paste?: boolean;
  readonly focus_reporting?: boolean;
  readonly mouse_tracking?: MouseTrackingMode;
  readonly mouse_encoding?: MouseEncoding;
  readonly modify_other_keys?: number;
  readonly kitty_keyboard?: number;
  readonly alt_screen?: boolean;
  readonly synchronized_update?: boolean;
}

/** Ancillary grid-level metadata (additive). */
export interface GridMeta {
  readonly title?: string | null;
  readonly cwd?: string | null;
  readonly hyperlink_digest?: string | null;
}

/**
 * Single DEC / xterm mode transition. Internally tagged on `mode` so an
 * unknown variant in a newer host JSON produces a deserialize error at the
 * boundary rather than a silent drop — matches the Rust-side decision.
 */
export type ModeChange =
  | { readonly mode: 'decckm'; readonly value: boolean }
  | { readonly mode: 'bracketed_paste'; readonly value: boolean }
  | { readonly mode: 'focus_reporting'; readonly value: boolean }
  | { readonly mode: 'mouse_tracking'; readonly value: MouseTrackingMode }
  | { readonly mode: 'mouse_encoding'; readonly value: MouseEncoding }
  | { readonly mode: 'modify_other_keys'; readonly value: number }
  | { readonly mode: 'kitty_keyboard'; readonly value: number }
  | { readonly mode: 'alt_screen'; readonly value: boolean }
  | { readonly mode: 'synchronized_update'; readonly value: boolean };

/** Full grid snapshot — emitted on connect/resume/resize/revision-resync. */
export interface GridSnapshotEvent {
  readonly kind: 'grid_snapshot';
  readonly rows: number;
  readonly cols: number;
  readonly buffer_kind: BufferKind;
  readonly row_deltas: readonly RowDelta[];
  readonly cursor?: CursorState | null;
  readonly mode_state: TerminalModeState;
  readonly meta?: GridMeta;
}

/** Incremental grid delta — steady-state event. */
export interface GridDeltaEvent {
  readonly kind: 'grid_delta';
  readonly row_deltas: readonly RowDelta[];
  readonly scrolls?: readonly ScrollDelta[];
  readonly scrollback_appended?: number;
}

/** Cursor-only move. */
export interface CursorMovedEvent {
  readonly kind: 'cursor_moved';
  readonly cursor: CursorState;
}

/** Mode-change batch. */
export interface ModeChangedEvent {
  readonly kind: 'mode_changed';
  readonly changes: readonly ModeChange[];
  readonly state: TerminalModeState;
}

/** OSC 0 / 2 title change. */
export interface TitleChangedEvent {
  readonly kind: 'title_changed';
  readonly title: string;
  readonly scope?: TitleScope;
}

/** BEL received. */
export interface BellRequestedEvent {
  readonly kind: 'bell_requested';
  /** Note: inner field name is `kind_of_bell` to avoid colliding with the
   *  outer event discriminator `kind`. */
  readonly kind_of_bell?: BellKind;
}

/** OSC 8 hyperlink announced. */
export interface HyperlinkAddedEvent {
  readonly kind: 'hyperlink_added';
  readonly id: number;
  readonly uri: string;
  readonly params?: string | null;
}

/** OSC 8 hyperlink retired. */
export interface HyperlinkRemovedEvent {
  readonly kind: 'hyperlink_removed';
  readonly id: number;
}

/** OSC 52 clipboard request. */
export interface ClipboardRequestEvent {
  readonly kind: 'clipboard_request';
  readonly selection: ClipboardSelection;
  readonly op: ClipboardOp;
}

/** DECSET 2026 / DCS BSU/ESU transition. */
export interface SynchronizedUpdateEvent {
  readonly kind: 'synchronized_update';
  readonly phase: SyncPhase;
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
  | InputSubmittedEvent
  | GridSnapshotEvent
  | GridDeltaEvent
  | CursorMovedEvent
  | ModeChangedEvent
  | TitleChangedEvent
  | BellRequestedEvent
  | HyperlinkAddedEvent
  | HyperlinkRemovedEvent
  | ClipboardRequestEvent
  | SynchronizedUpdateEvent;

export type HostEventKind = HostEvent['kind'];

/** Narrow a HostEvent to a specific kind. Useful for TS control flow. */
export function isEventOfKind<K extends HostEventKind>(
  event: HostEvent,
  kind: K,
): event is Extract<HostEvent, { kind: K }> {
  return event.kind === kind;
}
