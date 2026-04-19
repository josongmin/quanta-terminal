/**
 * xterm `modifyOtherKeys=2` sub-encoder — EPIC-E §3.3.
 *
 * Base behavior mirrors legacy for unmodified keys. The divergence is
 * for modified printables and Ctrl+Shift+letter, which emit
 * `ESC_BRK 27 ; <modifier> ; <keycode> ~`.
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

function namedKeycode(key: string): number | null {
  switch (key) {
    case 'Enter':
      return 13;
    case 'Tab':
      return 9;
    case 'Backspace':
      return 127;
    case 'Escape':
      return 27;
    default:
      return null;
  }
}

function isModifierOnly(key: string): boolean {
  switch (key) {
    case 'Shift':
    case 'Control':
    case 'Alt':
    case 'Meta':
    case 'CapsLock':
    case 'NumLock':
    case 'ScrollLock':
    case 'AltGraph':
    case 'Dead':
      return true;
    default:
      return false;
  }
}

export function encodeModifyOtherKeysV2(
  event: KeyEvent,
  snapshot: TerminalModeSnapshot,
): Uint8Array {
  if (isModifierOnly(event.key)) return new Uint8Array(0);

  const hasMod = event.shiftKey || event.altKey || event.ctrlKey;

  // Printable single-character keys under modifiers (excluding "Ctrl-only-letter"
  // which stays as the bare control byte for shell compatibility).
  if (hasMod && event.key.length === 1) {
    const isLetter = /^[a-zA-Z]$/.test(event.key);
    const ctrlOnly = event.ctrlKey && !event.shiftKey && !event.altKey;
    // Ctrl+letter (no Shift/Alt) keeps the bare control byte — matches legacy.
    if (isLetter && ctrlOnly) {
      return encodeLegacy(event, snapshot);
    }
    // Alt+letter alone in modifyOtherKeys=2 still emits ESC_BRK 27 per §3.3 (the
    // matrix anchors this: alt+a → ESC_BRK 27 ; 3 ; 97 ~). Plain printables
    // without modifiers go via legacy.
    const keycode = event.key.charCodeAt(0);
    return csi27(xtermModifier(event), keycode);
  }

  // Enter / Tab / Backspace / Escape with modifiers → ESC_BRK 27 form.
  if (hasMod) {
    const kc = namedKeycode(event.key);
    if (kc !== null) {
      return csi27(xtermModifier(event), kc);
    }
  }

  // Cursor / function / special keys and unmodified printables: delegate
  // to legacy. Their ESC_BRK forms already carry the modifier parameter and
  // match xterm under mkeys=2.
  return encodeLegacy(event, snapshot);
}
