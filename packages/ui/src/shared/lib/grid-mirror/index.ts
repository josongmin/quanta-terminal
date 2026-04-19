/**
 * Public surface of `@quanta/ui/shared/lib/grid-mirror` — the EPIC-C reducer
 * mirror that applies ordered wire events from the VT engine into a
 * renderer-facing grid model.
 *
 * See `GridMirror.ts` for the class; `types.ts` for the wire payload shapes;
 * `synchronized-update.ts` for the DECSET 2026 window helper; and
 * `ResyncRow.ts` for the row-scoped recovery protocol.
 */

export { GridMirror, CountingTelemetry } from './GridMirror.js';
export type { GridMirrorOptions, ResyncRowResponse } from './GridMirror.js';

export { SyncUpdateWindow } from './synchronized-update.js';
export type { SyncUpdateWindowOptions } from './synchronized-update.js';

export { createStubTransport } from './ResyncRow.js';
export type {
  ResyncRowRequest,
  ResyncRowResponse as ResyncRowResponseShape,
  ResyncRowTransport,
  ReplayFailedReason,
} from './ResyncRow.js';

export type {
  ApplyResult,
  BellKind,
  BufferKind,
  Cell,
  CellSpan,
  ClipboardOp,
  ClipboardSelection,
  CursorShape,
  CursorState,
  DiscardReason,
  GraphemeRun,
  GridDeltaPayload,
  GridEventEnvelope,
  GridMeta,
  GridPayload,
  GridSnapshotPayload,
  MirrorCounterName,
  MirrorTelemetry,
  ModeChange,
  Row,
  RowDelta,
  ScrollDelta,
  SnapshotRequest,
  SpanAttrsExt,
  SyncPhase,
  TerminalModeState,
  TitleScope,
  BellRequestedPayload,
  ClipboardRequestPayload,
  CursorMovedPayload,
  HyperlinkAddedPayload,
  HyperlinkRemovedPayload,
  ModeChangedPayload,
  SynchronizedUpdatePayload,
  TitleChangedPayload,
} from './types.js';
