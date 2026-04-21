/**
 * xterm `modifyOtherKeys=1` sub-encoder — EPIC-E §3.3 (partial mode).
 *
 * xterm's `CSI > 4 ; n m` escape enables the `ESC_BRK 27 ; <mod> ; <code> ~`
 * form for modified keys. The spec distinguishes two levels:
 *
 *   - `n=2` (full): every modified non-trivial key uses the CSI-27 form,
 *     including all printable combinations. Handled by
 *     `encodeModifyOtherKeysV2`.
 *   - `n=1` (partial): only *ambiguous* keys switch to CSI-27; everything
 *     else stays on the legacy byte. "Ambiguous" means the legacy byte
 *     collides with another keystroke so an application cannot tell
 *     them apart:
 *
 *        Tab       (0x09)  ≡  Ctrl+I
 *        Enter     (0x0d)  ≡  Ctrl+M
 *        Escape    (0x1b)  ≡  Ctrl+[
 *        Backspace (0x7f)  ≡  Ctrl+H (via 0x08 on Ctrl)
 *
 *     Any modifier combination over these keys goes through CSI-27 so
 *     the shell sees the real keystroke. Unmodified Tab/Enter/Esc
 *     still emit their plain byte — interactive shells (bash, zsh)
 *     depend on that shape.
 *
 * All other modified keys — `Ctrl+A`, `Alt+x`, cursor keys, function
 * keys, plain printables — defer to the legacy encoder. This is the
 * main divergence from `modifyOtherKeys=2`, where `Ctrl+Shift+A`,
 * `Alt+a`, `Ctrl+digit`, etc. all take the CSI-27 shape.
 */
import type { KeyEvent, TerminalModeSnapshot } from '../types';
import { encodeLegacy } from './legacy';
import { xtermModifier } from './shared';

const utf8Encoder = new TextEncoder();
const ESC_BRK = [0x1b, 0x5b] as const;

function csi27(modifier: number, keycode: number): Uint8Array {
  const text = `27;${modifier};${keycode}`;
  const out = new Uint8Array(ESC_BRK.length + text.length + 1);
  out[0] = ESC_BRK[0];
  out[1] = ESC_BRK[1];
  out.set(utf8Encoder.encode(text), 2);
  out[out.length - 1] = 0x7e;
  return out;
}

/**
 * xterm-native keycode for each ambiguous named key. xterm uses the
 * codepoint of the "canonical" legacy byte (0x09/0x0d/0x1b) for Tab /
 * Enter / Escape, and 0x7f for Backspace to match the DEL-on-Backspace
 * default in EPIC-E §3.2.
 */
function ambiguousKeycode(key: string): number | null {
  switch (key) {
    case 'Tab':
      return 9;
    case 'Enter':
      return 13;
    case 'Escape':
      return 27;
    case 'Backspace':
      return 127;
    default:
      return null;
  }
}

/**
 * An ambiguous key in mkeys=1 fires the CSI-27 form only when a
 * modifier is held; bare Tab / Enter / Escape / Backspace keep their
 * legacy single-byte encoding so interactive shells still see them.
 *
 * Shift alone is left to the legacy encoder for Tab (it already owns
 * `ESC [ Z` for Shift+Tab). For Enter / Escape / Backspace, shift is
 * treated like any other modifier.
 */
function shouldEmitCsi27(event: KeyEvent): boolean {
  if (event.ctrlKey || event.altKey) return true;
  if (event.shiftKey && event.key !== 'Tab') return true;
  return false;
}

export function encodeModifyOtherKeysV1(
  event: KeyEvent,
  snapshot: TerminalModeSnapshot,
): Uint8Array {
  const kc = ambiguousKeycode(event.key);
  if (kc !== null && shouldEmitCsi27(event)) {
    return csi27(xtermModifier(event), kc);
  }
  // Unambiguous / plain — defer to legacy (Shift+Tab, Ctrl+letter,
  // Alt+x, cursor keys, function keys, printables).
  return encodeLegacy(event, snapshot);
}
