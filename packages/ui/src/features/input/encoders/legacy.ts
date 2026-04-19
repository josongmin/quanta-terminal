/**
 * Legacy xterm key encoder — EPIC-E §3.2.
 *
 * Maps normalized `KeyEvent`s to xterm byte sequences. Pure function; no
 * DOM access, no ambient state. The only input beyond the event itself
 * is `DECCKM` from the `TerminalModeSnapshot` (cursor-keys app mode).
 */
import type { KeyEvent, TerminalModeSnapshot } from '../types';
import { xtermModifier } from './shared';

const ESC = 0x1b;
const ESC_BRK = [ESC, 0x5b] as const; // ESC [
const SS3 = [ESC, 0x4f] as const; // ESC O
const utf8Encoder = new TextEncoder();

/** Concatenate multiple byte chunks into a single Uint8Array. */
function concat(...chunks: Array<Uint8Array | number[] | readonly number[]>): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    if (c instanceof Uint8Array) {
      out.set(c, off);
      off += c.length;
    } else {
      for (let i = 0; i < c.length; i++, off++) out[off] = c[i]!;
    }
  }
  return out;
}

const F_KEY_CODE: Readonly<Record<string, number>> = {
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
  F13: 25,
  F14: 26,
  F15: 28,
  F16: 29,
  F17: 31,
  F18: 32,
  F19: 33,
  F20: 34,
  F21: 42,
  F22: 43,
  F23: 44,
  F24: 45,
};

const F1_F4_FINAL: Readonly<Record<string, number>> = {
  F1: 0x50, // P
  F2: 0x51, // Q
  F3: 0x52, // R
  F4: 0x53, // S
};

const ARROW_FINAL: Readonly<Record<string, number>> = {
  ArrowUp: 0x41, // A
  ArrowDown: 0x42, // B
  ArrowRight: 0x43, // C
  ArrowLeft: 0x44, // D
};

const ENDPOINT_FINAL: Readonly<Record<string, number>> = {
  Home: 0x48, // H
  End: 0x46, // F
};

const SPECIAL_TILDE_CODE: Readonly<Record<string, number>> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};

const CTRL_SYMBOL: Readonly<Record<string, number>> = {
  '[': 0x1b,
  '\\': 0x1c,
  ']': 0x1d,
  '^': 0x1e,
  '_': 0x1f,
  ' ': 0x00,
  '@': 0x00,
  '/': 0x1f,
  '?': 0x7f,
};

function wrapAlt(bytes: Uint8Array, alt: boolean): Uint8Array {
  return alt ? concat([ESC], bytes) : bytes;
}

function encodeArrow(ev: KeyEvent, snapshot: TerminalModeSnapshot): Uint8Array | null {
  const final = ARROW_FINAL[ev.key];
  if (final === undefined) return null;
  const mod = xtermModifier(ev);
  if (mod === 1) {
    // Unmodified arrows — DECCKM toggles between ESC [ and ESC O.
    const intro = snapshot.decckm ? SS3 : ESC_BRK;
    return Uint8Array.from([...intro, final]);
  }
  // Modified: ESC_BRK 1 ; <mod> <final>. DECCKM is ignored for modified form.
  return concat([...ESC_BRK], utf8Encoder.encode(`1;${mod}`), [final]);
}

function encodeEndpoint(ev: KeyEvent, snapshot: TerminalModeSnapshot): Uint8Array | null {
  const final = ENDPOINT_FINAL[ev.key];
  if (final === undefined) return null;
  const mod = xtermModifier(ev);
  if (mod === 1) {
    const intro = snapshot.decckm ? SS3 : ESC_BRK;
    return Uint8Array.from([...intro, final]);
  }
  return concat([...ESC_BRK], utf8Encoder.encode(`1;${mod}`), [final]);
}

function encodeSpecialTilde(ev: KeyEvent): Uint8Array | null {
  const code = SPECIAL_TILDE_CODE[ev.key];
  if (code === undefined) return null;
  const mod = xtermModifier(ev);
  if (mod === 1) {
    return concat([...ESC_BRK], utf8Encoder.encode(String(code)), [0x7e]);
  }
  return concat([...ESC_BRK], utf8Encoder.encode(`${code};${mod}`), [0x7e]);
}

function encodeFKey(ev: KeyEvent): Uint8Array | null {
  if (ev.key in F1_F4_FINAL) {
    const final = F1_F4_FINAL[ev.key]!;
    const mod = xtermModifier(ev);
    if (mod === 1) {
      return Uint8Array.from([...SS3, final]);
    }
    // ESC O 1 ; <mod> <final>
    return concat([...SS3], utf8Encoder.encode(`1;${mod}`), [final]);
  }
  const tildeCode = F_KEY_CODE[ev.key];
  if (tildeCode === undefined) return null;
  const mod = xtermModifier(ev);
  if (mod === 1) {
    return concat([...ESC_BRK], utf8Encoder.encode(String(tildeCode)), [0x7e]);
  }
  return concat([...ESC_BRK], utf8Encoder.encode(`${tildeCode};${mod}`), [0x7e]);
}

/**
 * Legacy xterm encoding. Top-level contract: returns raw bytes OR an
 * empty Uint8Array when the key is not representable. Caller (KeyEncoder)
 * applies the IME short-circuit; this function assumes `isComposing=false`.
 */
export function encodeLegacy(event: KeyEvent, snapshot: TerminalModeSnapshot): Uint8Array {
  // Arrow keys
  const arrow = encodeArrow(event, snapshot);
  if (arrow) return arrow;

  // Home / End — DECCKM-aware
  const endpoint = encodeEndpoint(event, snapshot);
  if (endpoint) return endpoint;

  // Insert / Delete / PageUp / PageDown
  const special = encodeSpecialTilde(event);
  if (special) return special;

  // Function keys
  const fkey = encodeFKey(event);
  if (fkey) return fkey;

  // Named keys
  switch (event.key) {
    case 'Enter':
      return wrapAlt(Uint8Array.of(0x0d), event.altKey);
    case 'Tab':
      if (event.shiftKey && !event.ctrlKey && !event.altKey) {
        return Uint8Array.of(ESC, 0x5b, 0x5a); // ESC [ Z
      }
      return wrapAlt(Uint8Array.of(0x09), event.altKey);
    case 'Backspace':
      // Unmodified Backspace emits DEL (0x7F) per DECISION in §3.2.
      // Ctrl+Backspace is often mapped to Alt+Backspace by terminals; here
      // we emit 0x08 (BS) when Ctrl is held to disambiguate from Ctrl+H.
      if (event.ctrlKey) return wrapAlt(Uint8Array.of(0x08), event.altKey);
      return wrapAlt(Uint8Array.of(0x7f), event.altKey);
    case 'Escape':
      return Uint8Array.of(0x1b);
    case ' ': {
      if (event.ctrlKey) return wrapAlt(Uint8Array.of(0x00), event.altKey);
      return wrapAlt(Uint8Array.of(0x20), event.altKey);
    }
  }

  // Ctrl + letter
  if (event.ctrlKey && /^[a-zA-Z]$/.test(event.key)) {
    const upper = event.key.toUpperCase().charCodeAt(0);
    const ctrlByte = upper & 0x1f;
    return wrapAlt(Uint8Array.of(ctrlByte), event.altKey);
  }

  // Ctrl + symbol ([ \ ] ^ _ @ ? /)
  if (event.ctrlKey && event.key.length === 1) {
    const mapped = CTRL_SYMBOL[event.key];
    if (mapped !== undefined) {
      return wrapAlt(Uint8Array.of(mapped), event.altKey);
    }
  }

  // Plain printable (length 1 after Unicode grapheme normalization — we
  // trust KeyEvent.key to be the composed glyph). Apply Alt prefix if set.
  if (event.key.length >= 1 && !event.ctrlKey) {
    // Don't emit for modifier-only keys like "Shift", "Control", etc.
    if (isModifierName(event.key)) return new Uint8Array(0);
    const payload = utf8Encoder.encode(event.key);
    return wrapAlt(payload, event.altKey);
  }

  return new Uint8Array(0);
}

function isModifierName(key: string): boolean {
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
