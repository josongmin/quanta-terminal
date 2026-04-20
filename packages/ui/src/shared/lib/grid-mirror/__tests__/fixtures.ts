/**
 * Test fixtures / builders shared across the grid-mirror test suite.
 * Keeping these in one place avoids scattering the (verbose) envelope-shape
 * boilerplate across 8+ test files.
 */

import type {
  BufferKind,
  CellSpan,
  CursorMovedPayload,
  CursorState,
  GridDeltaPayload,
  GridEventEnvelope,
  GridPayload,
  GridSnapshotPayload,
  ModeChange,
  ModeChangedPayload,
  PromptMarkKind,
  PromptMarkPayload,
  RowDelta,
  ScrollDelta,
  TerminalModeState,
  TitleChangedPayload,
  TitleScope,
} from '../types.js';

export const DEFAULT_SESSION_ID = '01J00000000000000000000001';

export function makeEnv<P extends GridPayload>(
  payload: P,
  opts: {
    grid_epoch?: number;
    sequence_no?: number;
    resize_generation?: number;
    buffer_kind?: BufferKind;
    session_id?: string;
  } = {},
): GridEventEnvelope<P> {
  return {
    session_id: opts.session_id ?? DEFAULT_SESSION_ID,
    grid_epoch: opts.grid_epoch ?? 1,
    sequence_no: opts.sequence_no ?? 1,
    resize_generation: opts.resize_generation ?? 0,
    buffer_kind: opts.buffer_kind ?? 'main',
    payload,
  };
}

export function blankSnapshot(
  rows = 4,
  cols = 8,
  seq = 0,
  epoch = 1,
): GridEventEnvelope<GridSnapshotPayload> {
  const row_deltas: RowDelta[] = [];
  for (let r = 0; r < rows; r += 1) {
    row_deltas.push({
      row: r,
      revision_before: 0,
      revision_after: 1,
      spans: [blankSpan(cols)],
      continuation: false,
      hyperlink_refs: [],
    });
  }
  return makeEnv(
    {
      kind: 'grid_snapshot',
      rows,
      cols,
      buffer_kind: 'main',
      row_deltas,
      cursor: defaultCursor(),
      mode_state: {},
      meta: {},
    },
    { grid_epoch: epoch, sequence_no: seq, resize_generation: 0 },
  );
}

export function defaultCursor(row = 0, col = 0): CursorState {
  return {
    row,
    col,
    visible: true,
    shape: 'block',
    blinking: true,
    pending_wrap: false,
  };
}

export function blankSpan(cols: number): CellSpan {
  return {
    cols,
    sgr: '0x0000000000000000',
    graphemes: 'blank',
    hyperlink_id: 0,
    ext: null,
  };
}

export function textSpan(text: string, cols = text.length): CellSpan {
  return {
    cols,
    sgr: '0x0000000000000000',
    graphemes: { utf8: text },
    hyperlink_id: 0,
    ext: null,
  };
}

export function repeatSpan(g: string, count: number): CellSpan {
  return {
    cols: count,
    sgr: '0x0000000000000000',
    graphemes: { grapheme: g, count },
    hyperlink_id: 0,
    ext: null,
  };
}

export function deltaEnv(
  rows: RowDelta[],
  opts: {
    seq: number;
    epoch?: number;
    resize_generation?: number;
    buffer_kind?: BufferKind;
    scrolls?: ScrollDelta[];
    scrollback_appended?: number;
  },
): GridEventEnvelope<GridDeltaPayload> {
  return makeEnv(
    {
      kind: 'grid_delta',
      row_deltas: rows,
      scrolls: opts.scrolls ?? [],
      scrollback_appended: opts.scrollback_appended ?? 0,
    },
    {
      grid_epoch: opts.epoch ?? 1,
      sequence_no: opts.seq,
      resize_generation: opts.resize_generation ?? 0,
      buffer_kind: opts.buffer_kind ?? 'main',
    },
  );
}

export function cursorEnv(
  cursor: CursorState,
  opts: { seq: number; epoch?: number; buffer_kind?: BufferKind },
): GridEventEnvelope<CursorMovedPayload> {
  return makeEnv<CursorMovedPayload>(
    { kind: 'cursor_moved', cursor },
    {
      grid_epoch: opts.epoch ?? 1,
      sequence_no: opts.seq,
      resize_generation: 0,
      buffer_kind: opts.buffer_kind ?? 'main',
    },
  );
}

export function modeEnv(
  changes: readonly ModeChange[],
  state: TerminalModeState,
  opts: { seq: number; epoch?: number },
): GridEventEnvelope<ModeChangedPayload> {
  return makeEnv<ModeChangedPayload>(
    { kind: 'mode_changed', changes, state },
    {
      grid_epoch: opts.epoch ?? 1,
      sequence_no: opts.seq,
      resize_generation: 0,
    },
  );
}

export function titleEnv(
  title: string,
  scope: TitleScope,
  opts: { seq: number; epoch?: number },
): GridEventEnvelope<TitleChangedPayload> {
  return makeEnv<TitleChangedPayload>(
    { kind: 'title_changed', title, scope },
    { grid_epoch: opts.epoch ?? 1, sequence_no: opts.seq },
  );
}

/**
 * Build an OSC 133 `prompt_mark` envelope. `row`/`col` default to undefined
 * (engine can't always report them), `exit_code` likewise. Tests that need a
 * D-with-code pass it explicitly.
 */
export function promptMarkEnv(
  mark: PromptMarkKind,
  opts: {
    seq: number;
    epoch?: number;
    row?: number;
    col?: number;
    exit_code?: number | null;
    aid?: string | null;
  },
): GridEventEnvelope<PromptMarkPayload> {
  const payload: PromptMarkPayload = {
    kind: 'prompt_mark',
    mark,
    ...(opts.row !== undefined ? { row: opts.row } : {}),
    ...(opts.col !== undefined ? { col: opts.col } : {}),
    ...(opts.exit_code !== undefined ? { exit_code: opts.exit_code } : {}),
    ...(opts.aid !== undefined ? { aid: opts.aid } : {}),
  };
  return makeEnv<PromptMarkPayload>(payload, {
    grid_epoch: opts.epoch ?? 1,
    sequence_no: opts.seq,
  });
}
