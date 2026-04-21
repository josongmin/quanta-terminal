/**
 * Internal types for the VtEmulator.
 *
 * These shapes are intentionally mutable and local — the only thing that
 * leaves the module is a `GridEventEnvelope<GridPayload>` (immutable).
 */

import type { AnsiColor } from '../../ui/ansi-output/types.js';

/**
 * Internal cell state — mirrors the `AnsiSpan` attribute surface plus width.
 *
 * `grapheme === ''` means blank (no printable). A 2-cell wide grapheme is
 * stored as: first cell `{ grapheme: 'X', width: 2 }`, second cell
 * `{ grapheme: '', width: 0 }` (width===0 marks the continuation half so
 * scans can tell "blank" from "wide tail").
 */
export interface InternalCell {
  grapheme: string;
  /** 1 for normal, 2 for wide-leading, 0 for wide-trailing continuation. */
  width: 0 | 1 | 2;
  fg: AnsiColor | 'default';
  bg: AnsiColor | 'default';
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
  dim: boolean;
  hidden: boolean;
  blink: boolean;
}

export interface InternalCursor {
  row: number;
  col: number;
  visible: boolean;
  shape: 'block' | 'underline' | 'bar';
  blinking: boolean;
  /** DECAWM: when the cursor just wrote to the last column, the next print
   *  causes a wrap. Mirrors xterm's `LastColumnFlag`. */
  pendingWrap: boolean;
}

export interface InternalScrollRegion {
  /** inclusive, 0-indexed */
  top: number;
  /** inclusive, 0-indexed */
  bottom: number;
}

export interface InternalSgrStyle {
  fg: AnsiColor | 'default';
  bg: AnsiColor | 'default';
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
  dim: boolean;
  hidden: boolean;
  blink: boolean;
}

export interface InternalSavedState {
  cursor: InternalCursor;
  sgr: InternalSgrStyle;
  /**
   * DECAWM (auto-wrap). Per xterm, DECSC saves cursor position, SGR,
   * charset, wrap flag, and origin mode — NOT the scroll region.
   */
  autoWrap: boolean;
}

/**
 * A screen buffer — either the main (scrollable, reflows on resize) or the
 * alt buffer (no scrollback, clears on resize). Alt-buffer entry/exit is
 * driven by DEC private modes 47 / 1047 / 1049; we keep the inactive buffer
 * in a dormant field (`dormant` on `VtEmulator`) and swap pointers on
 * transition so all write ops always target whichever buffer is active.
 *
 * `rowRevisions` is a `Uint32Array` sized to `grid.length`. It is
 * per-buffer so cross-buffer deltas never collide on the same row number.
 *
 * Scrollback (plan-0005 α3) is attached to the emulator's main-buffer state
 * only; see `Scrollback` below. Alt buffer contributes nothing to scrollback.
 */
export interface Buffer {
  grid: InternalCell[][];
  rowRevisions: Uint32Array;
}

/**
 * A single row held in the bounded scrollback ring.
 *
 * `cells` is a cloned snapshot at capture time — mutating the live grid
 * afterwards must NOT alter the captured row (the scrollback is what the
 * user scrolled past, not a live reference).
 *
 * `pinned` is reserved for P1 block-boundary bookkeeping: when a "running
 * block" starts at a row that has since been evicted off the top of the
 * screen, the block engine will set `pinned = true` on that row so the
 * bounded ring refuses to drop it even if the cap is exceeded. In P0 nothing
 * pins — the marker exists purely as a hook for the future block overlay.
 */
export interface ScrollbackRow {
  readonly cells: readonly InternalCell[];
  /** Set when this row is the start row of a "running" block; eviction
   *  refuses to cross this marker. In P0 default, nothing pins — the
   *  marker exists for P1 block-boundary use. */
  pinned?: boolean;
}

/**
 * Bounded circular scrollback attached to the main buffer.
 *
 * `maxRows === 0` disables capture entirely (used by tiny-shell tests and
 * situations where the caller prefers a fixed-size memory footprint).
 *
 * `rows` stores oldest-first; eviction walks from index 0. When the head
 * candidate is `pinned`, eviction PAUSES (the ring may grow past `maxRows`).
 * This preserves the block-start-row invariant: if a block engine in P1
 * pinned the row, discarding it would invalidate the block's row-range ref.
 * Pause-eviction is strictly safer than dropping pinned rows because the
 * steady-state memory footprint still tops out at `maxRows + <live pins>`,
 * and live pins are bounded by the number of in-flight running blocks.
 *
 * `baseRowId` is the monotonic id of the oldest surviving row. IDs advance
 * only when eviction occurs, so external callers can reliably identify a
 * scrollback row across appends even as the head shifts.
 */
export interface Scrollback {
  /** Configured max rows. 0 means disabled. */
  readonly maxRows: number;
  /** Current rows, oldest first. */
  readonly rows: ScrollbackRow[];
  /** Monotonic rowId given to the oldest surviving row; rowIds grow
   *  upwards as rows are appended. Useful for P1 row-range refs. */
  baseRowId: number;
  /** Total rows evicted since creation. Diagnostic counter. */
  evictedCount: number;
  /** Count of eviction attempts skipped because the head row was pinned.
   *  Diagnostic only — surfaced in tests and optionally future telemetry. */
  pinBlockedEvictions: number;
}

export function defaultSgr(): InternalSgrStyle {
  return {
    fg: 'default',
    bg: 'default',
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    strike: false,
    dim: false,
    hidden: false,
    blink: false,
  };
}

export function blankCell(): InternalCell {
  return {
    grapheme: '',
    width: 1,
    fg: 'default',
    bg: 'default',
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    strike: false,
    dim: false,
    hidden: false,
    blink: false,
  };
}

export function blankCellWithSgr(sgr: InternalSgrStyle): InternalCell {
  return {
    grapheme: '',
    width: 1,
    fg: sgr.fg,
    bg: sgr.bg,
    bold: sgr.bold,
    italic: sgr.italic,
    underline: sgr.underline,
    inverse: sgr.inverse,
    strike: sgr.strike,
    dim: sgr.dim,
    hidden: sgr.hidden,
    blink: sgr.blink,
  };
}

export function cellsEqual(a: InternalCell, b: InternalCell): boolean {
  return (
    a.grapheme === b.grapheme &&
    a.width === b.width &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strike === b.strike &&
    a.dim === b.dim &&
    a.hidden === b.hidden &&
    a.blink === b.blink &&
    colorEq(a.fg, b.fg) &&
    colorEq(a.bg, b.bg)
  );
}

export function colorEq(
  a: AnsiColor | 'default',
  b: AnsiColor | 'default',
): boolean {
  if (a === 'default' && b === 'default') return true;
  if (a === 'default' || b === 'default') return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'named' && b.kind === 'named') return a.index === b.index;
  if (a.kind === 'bright' && b.kind === 'bright') return a.index === b.index;
  if (a.kind === 'indexed' && b.kind === 'indexed') return a.index === b.index;
  if (a.kind === 'rgb' && b.kind === 'rgb') {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  }
  if (a.kind === 'default' && b.kind === 'default') return true;
  return false;
}
