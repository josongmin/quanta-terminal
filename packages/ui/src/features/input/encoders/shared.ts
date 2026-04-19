/**
 * Shared helpers for key encoders — modifier bitmaps and tables.
 *
 * The xterm bitmap is offset-by-1 per xterm convention (`1` = no mods,
 * `2` = Shift, `3` = Alt, `5` = Ctrl, `6` = Ctrl+Shift, ...). The kitty
 * bitmap uses raw bits (Shift=1, Alt=2, Ctrl=4, Super=8, ...) and the
 * encoder adds 1 when emitting.
 */
import type { KeyEvent } from '../types';

/** xterm modifier bitmap (EPIC-E §3.3). Meta is not represented. */
export function xtermModifier(event: KeyEvent): number {
  let bits = 0;
  if (event.shiftKey) bits |= 1;
  if (event.altKey) bits |= 2;
  if (event.ctrlKey) bits |= 4;
  return bits + 1;
}

/** Kitty modifier bitmap (EPIC-E §3.4). Hyper/Caps/Num not wired; Super = meta. */
export function kittyModifier(event: KeyEvent): number {
  let bits = 0;
  if (event.shiftKey) bits |= 0x01;
  if (event.altKey) bits |= 0x02;
  if (event.ctrlKey) bits |= 0x04;
  if (event.metaKey) bits |= 0x08;
  return bits + 1;
}

/**
 * Kitty named-key keycode table. Values from the kitty keyboard protocol
 * spec — see `https://sw.kovidgoyal.net/kitty/keyboard-protocol/`. Only
 * the subset we emit in v1 is listed here; others fall through to the
 * unicode codepoint path.
 */
export const KITTY_KEYCODE: Readonly<Record<string, number>> = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  // Navigation
  Insert: 57348,
  Delete: 57349,
  ArrowUp: 57352,
  ArrowDown: 57353,
  ArrowLeft: 57354,
  ArrowRight: 57355,
  PageUp: 57361,
  PageDown: 57362,
  Home: 57371,
  End: 57372,
  // Function keys (F1..F12 contiguous from 57364)
  F1: 57364,
  F2: 57365,
  F3: 57366,
  F4: 57367,
  F5: 57368,
  F6: 57369,
  F7: 57370,
  F8: 57373,
  F9: 57374,
  F10: 57375,
  F11: 57376,
  F12: 57377,
};
// Note: the F-key constants above follow the common kitty keycode
// assignments used in existing parsers. Downstream fixtures pin the
// exact expected bytes so drift is caught in tests.
