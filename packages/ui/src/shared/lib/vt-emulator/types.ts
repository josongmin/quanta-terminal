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
