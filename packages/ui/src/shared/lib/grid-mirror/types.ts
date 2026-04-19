/**
 * TS types mirroring `crates/quanta-proto::events_grid` payload structs.
 *
 * Field names stay snake_case to match the wire without an intermediary
 * camelCase layer; the wire is the single source of truth. When the
 * Rust→TS codegen pipeline lands (ADR 0014 §Schema Sharing), this file
 * becomes generated output.
 */

import type {
  BellKind,
  BufferKind,
  CellSpan,
  ClipboardOp,
  ClipboardSelection,
  CursorShape,
  CursorState,
  GraphemeRun,
  GridMeta,
  ModeChange,
  RowDelta,
  ScrollDelta,
  SpanAttrsExt,
  SyncPhase,
  TerminalModeState,
  TitleScope,
} from '@quanta/host-common';

export type {
  BellKind,
  BufferKind,
  CellSpan,
  ClipboardOp,
  ClipboardSelection,
  CursorShape,
  CursorState,
  GraphemeRun,
  GridMeta,
  ModeChange,
  RowDelta,
  ScrollDelta,
  SpanAttrsExt,
  SyncPhase,
  TerminalModeState,
  TitleScope,
};

/**
 * Ordered envelope carrying a grid-reducer payload.
 *
 * Mirror consumers apply events in `(grid_epoch, sequence_no)` ascending
 * order per ADR 0017 §2.
 */
export interface GridEventEnvelope<P> {
  readonly session_id: string;
  readonly grid_epoch: number;
  /** `sequence_no` — strictly ascending within an epoch. */
  readonly sequence_no: number;
  readonly resize_generation: number;
  readonly buffer_kind: BufferKind;
  readonly payload: P;
}

/* ---------- payload shapes (mirror Rust `events_grid.rs`) ---------- */

export interface GridSnapshotPayload {
  readonly kind: 'grid_snapshot';
  readonly rows: number;
  readonly cols: number;
  readonly buffer_kind: BufferKind;
  readonly row_deltas: readonly RowDelta[];
  readonly cursor?: CursorState | null;
  readonly mode_state: TerminalModeState;
  readonly meta?: GridMeta;
}

export interface GridDeltaPayload {
  readonly kind: 'grid_delta';
  readonly row_deltas: readonly RowDelta[];
  readonly scrolls?: readonly ScrollDelta[];
  readonly scrollback_appended?: number;
}

export interface CursorMovedPayload {
  readonly kind: 'cursor_moved';
  readonly cursor: CursorState;
}

export interface ModeChangedPayload {
  readonly kind: 'mode_changed';
  readonly changes: readonly ModeChange[];
  readonly state: TerminalModeState;
}

export interface TitleChangedPayload {
  readonly kind: 'title_changed';
  readonly title: string;
  readonly scope?: TitleScope;
}

export interface BellRequestedPayload {
  readonly kind: 'bell_requested';
  readonly kind_of_bell?: BellKind;
}

export interface HyperlinkAddedPayload {
  readonly kind: 'hyperlink_added';
  readonly id: number;
  readonly uri: string;
  readonly params?: string | null;
}

export interface HyperlinkRemovedPayload {
  readonly kind: 'hyperlink_removed';
  readonly id: number;
}

export interface ClipboardRequestPayload {
  readonly kind: 'clipboard_request';
  readonly selection: ClipboardSelection;
  readonly op: ClipboardOp;
}

export interface SynchronizedUpdatePayload {
  readonly kind: 'synchronized_update';
  readonly phase: SyncPhase;
}

/** Discriminated union of every grid-reducer payload kind. */
export type GridPayload =
  | GridSnapshotPayload
  | GridDeltaPayload
  | CursorMovedPayload
  | ModeChangedPayload
  | TitleChangedPayload
  | BellRequestedPayload
  | HyperlinkAddedPayload
  | HyperlinkRemovedPayload
  | ClipboardRequestPayload
  | SynchronizedUpdatePayload;

/* ---------- mirror-local types ---------- */

/** A cell, as exposed to renderers. One per column position. */
export interface Cell {
  readonly grapheme: string;
  readonly cols: number;
  readonly sgr: string;
  readonly hyperlink_id: number;
  readonly ext: SpanAttrsExt | null;
}

/** Expanded row content, ready for paint. */
export interface Row {
  readonly cells: readonly Cell[];
  readonly continuation: boolean;
  readonly revision: number;
}

/** Discriminator + outcome of an apply call. */
export type ApplyResult =
  | { readonly outcome: 'applied' }
  | { readonly outcome: 'discarded'; readonly reason: DiscardReason }
  | { readonly outcome: 'resync_requested'; readonly row?: number }
  | { readonly outcome: 'snapshot_requested' };

export type DiscardReason =
  | 'stale_epoch'
  | 'stale_resize_generation'
  | 'stale_sequence'
  | 'unknown_variant';

/** Pair of `(session_id, grid_epoch, resize_generation, row)` for row-scoped resync. */
export interface ResyncRowRequest {
  readonly session_id: string;
  readonly grid_epoch: number;
  readonly resize_generation: number;
  readonly row: number;
}

/** Reason carried on a snapshot-level resync request. */
export interface SnapshotRequest {
  readonly session_id: string;
  readonly epoch: number;
  readonly reason:
    | 'row_mismatch_storm'
    | 'epoch_advanced_without_snapshot'
    | 'replay_failed';
}

/** Telemetry counter bag. Keys match ADR 0017 §5. */
export interface MirrorTelemetry {
  incr(counter: MirrorCounterName, by?: number): void;
}

export type MirrorCounterName =
  | 'stale_epoch_drop'
  | 'stale_sequence_drop'
  | 'stale_resize_generation_drop'
  | 'revision_mismatch'
  | 'snapshot_fallback'
  | 'snapshot_fallback_storm_triggered'
  | 'synchronized_update_timeouts'
  | 'unknown_protocol_field_observed';
