/**
 * Kitty keyboard protocol sub-encoder for levels 1-3 — EPIC-E §3.4.
 *
 * Level 1: `ESC_BRK <kc> ; <mod> u` on every press.
 * Level 2: adds release form with event-kind 3, autorepeat form with 2.
 * Level 3: adds alternate-layout codepoint via `<kc> : <alt>`.
 *
 * Level 4-5 are clamped to 3 with `diagnostics.deprecatedFallback = true`
 * in the top-level dispatcher.
 */
import type { KeyEvent, TerminalModeSnapshot } from '../types';
import { KITTY_KEYCODE, kittyModifier } from './shared';

const utf8Encoder = new TextEncoder();
const ESC_BRK = [0x1b, 0x5b] as const;

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

function keyToKeycode(event: KeyEvent): number | null {
  if (event.key in KITTY_KEYCODE) return KITTY_KEYCODE[event.key]!;
  if (event.key.length >= 1) {
    // Use the Unicode codepoint of the first code unit of the key glyph.
    // Kitty spec expects the lowercase codepoint for letter keys; browsers
    // give us the post-shift glyph in `key` so we fold back.
    const base = event.key.toLowerCase();
    return base.codePointAt(0) ?? null;
  }
  return null;
}

function altCodepoint(event: KeyEvent): number | null {
  // Level 3 alternate-layout: inspect `code` for the physical key. If
  // it's a `KeyX` code, the "expected" US-layout glyph for that key is
  // the lowercase letter after the `Key` prefix.
  const code = event.code;
  if (code.startsWith('Key') && code.length === 4) {
    const us = code.charAt(3).toLowerCase();
    const cur = event.key.toLowerCase();
    if (us !== cur) return us.charCodeAt(0);
  }
  return null;
}

function buildCsiU(params: string): Uint8Array {
  const encoded = utf8Encoder.encode(params);
  const out = new Uint8Array(ESC_BRK.length + encoded.length + 1);
  out[0] = ESC_BRK[0];
  out[1] = ESC_BRK[1];
  out.set(encoded, 2);
  out[out.length - 1] = 0x75; // 'u'
  return out;
}

/** Level can be clamped to 3 by the dispatcher for L4/L5. */
export function encodeKitty(
  event: KeyEvent,
  _snapshot: TerminalModeSnapshot,
  level: 1 | 2 | 3,
): Uint8Array {
  if (isModifierOnly(event.key)) return new Uint8Array(0);

  const kc = keyToKeycode(event);
  if (kc === null) return new Uint8Array(0);
  const mod = kittyModifier(event);

  // Keycode with optional L3 alternate
  let keycodePart = String(kc);
  if (level >= 3) {
    const alt = altCodepoint(event);
    if (alt !== null) keycodePart = `${kc}:${alt}`;
  }

  // Event-kind suffix (L2+ only)
  let eventKindSuffix = '';
  if (level >= 2) {
    if (event.kind === 'keyup') {
      eventKindSuffix = ';3';
    } else if (event.repeat) {
      eventKindSuffix = ';2';
    }
  }

  // Shape: ESC_BRK <kc[:alt]> ; <mod> [; <kind>] u
  // Kitty spec allows omitting the leading mod parameter when it's 1, but
  // we emit it explicitly for parity with common reference encoders.
  const params = `${keycodePart};${mod}${eventKindSuffix}`;
  return buildCsiU(params);
}
