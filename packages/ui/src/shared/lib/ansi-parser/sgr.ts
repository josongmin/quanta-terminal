/**
 * SGR (Select Graphic Rendition) interpreter.
 *
 * Applies a `CSI … m` parameter list to a mutable `Style` record in place.
 * The FSM (see `parser.ts`) owns a single `Style` instance and reuses it
 * across escapes; a span snapshot is taken whenever style changes.
 *
 * Scope — exactly what Phase 2 ships:
 *   0                         reset all
 *   1 bold / 22 unbold        (22 clears both bold and dim)
 *   2 dim
 *   3 italic / 23 no-italic
 *   4 underline / 21 double   (21 is mapped to underline; no distinction)
 *   24 no-underline
 *   7 inverse / 27 no-inverse
 *   8 hidden  / 28 no-hidden
 *   9 strike  / 29 no-strike
 *   30-37 fg / 39 default fg / 90-97 bright fg
 *   40-47 bg / 49 default bg / 100-107 bright bg
 *   38;5;N / 48;5;N indexed 256-color
 *   38;2;R;G;B / 48;2;R;G;B truecolor
 *
 * Out of scope (silently skipped):
 *   - 5/6 blink, 10-19 font select, 20 fraktur, 25 no-blink
 *   - 50-55 frame/ideogram, 58/59 underline color, 73-75 sub/superscript
 *
 * The interpreter is intentionally permissive: malformed truecolor like
 * `\x1b[38;2;255m` (short) consumes the prefix and moves on. This matches
 * what real terminals do in practice.
 */

import type { AnsiColor, AnsiSpan } from './types.js';

/**
 * Mutable style state owned by the parser. Flags are stored as booleans rather
 * than a bitfield so TypeScript catches typos in the FSM; the overhead is
 * negligible next to string decoding.
 */
export interface Style {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
  hidden: boolean;
  link?: string;
}

export function createStyle(): Style {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
    hidden: false,
  };
}

/** Reset `s` to the neutral style in place. Equivalent to SGR `0`. */
export function resetStyle(s: Style): void {
  delete s.fg;
  delete s.bg;
  s.bold = false;
  s.dim = false;
  s.italic = false;
  s.underline = false;
  s.strike = false;
  s.inverse = false;
  s.hidden = false;
  // `link` is intentionally NOT cleared by SGR 0 — OSC 8 has its own close
  // sequence, and real terminals preserve link state across SGR resets.
}

/**
 * Build an immutable `AnsiSpan` from the current style + text. Omits any flag
 * that is false / any color that is absent so snapshots stay minimal and
 * deep-equal friendly.
 */
export function spanFromStyle(text: string, s: Style): AnsiSpan {
  const out: { -readonly [K in keyof AnsiSpan]: AnsiSpan[K] } = { text };
  if (s.fg !== undefined) out.fg = s.fg;
  if (s.bg !== undefined) out.bg = s.bg;
  if (s.bold) out.bold = true;
  if (s.dim) out.dim = true;
  if (s.italic) out.italic = true;
  if (s.underline) out.underline = true;
  if (s.strike) out.strike = true;
  if (s.inverse) out.inverse = true;
  if (s.hidden) out.hidden = true;
  if (s.link !== undefined) out.link = s.link;
  return out as AnsiSpan;
}

function namedFg(code: number): AnsiColor {
  const index = (code - 30) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  return { kind: 'named', index };
}

function namedBg(code: number): AnsiColor {
  const index = (code - 40) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  return { kind: 'named', index };
}

function brightFg(code: number): AnsiColor {
  const index = (code - 90) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  return { kind: 'bright', index };
}

function brightBg(code: number): AnsiColor {
  const index = (code - 100) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  return { kind: 'bright', index };
}

function clamp255(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 255) return 255;
  return n | 0;
}

/**
 * Consume an extended-color sub-sequence starting at index `i` of `params`.
 * Returns the color (or undefined if malformed) and the index of the last
 * consumed element. The SGR param at `params[i-1]` is the 38 / 48 prefix.
 *
 *   params[i]     = 5 (indexed)  → need params[i+1]
 *   params[i]     = 2 (rgb)      → need params[i+1..i+3]
 *
 * Malformed sequences (missing trailing params) return undefined and consume
 * whatever was present so the caller advances past the bad run.
 */
function parseExtendedColor(
  params: readonly number[],
  i: number,
): { color: AnsiColor | undefined; consumed: number } {
  const mode = params[i];
  if (mode === 5) {
    const n = params[i + 1];
    if (n === undefined) return { color: undefined, consumed: 1 };
    return { color: { kind: 'indexed', index: clamp255(n) }, consumed: 2 };
  }
  if (mode === 2) {
    const r = params[i + 1];
    const g = params[i + 2];
    const b = params[i + 3];
    if (r === undefined || g === undefined || b === undefined) {
      // Consume whatever was present so the caller doesn't loop.
      const avail = [r, g, b].filter((x) => x !== undefined).length;
      return { color: undefined, consumed: 1 + avail };
    }
    return { color: { kind: 'rgb', r: clamp255(r), g: clamp255(g), b: clamp255(b) }, consumed: 4 };
  }
  // Unknown extended mode (0/1/3/4 legacy sub-modes): skip just the mode byte.
  return { color: undefined, consumed: 1 };
}

/**
 * Apply an SGR parameter list to `s` in place.
 *
 * An empty list (`CSI m`) means `CSI 0 m` per ECMA-48; we canonicalise that
 * in the caller so this function always sees at least `[0]`.
 */
export function applySgr(params: readonly number[], s: Style): void {
  let i = 0;
  while (i < params.length) {
    const p = params[i]!;
    switch (p) {
      case 0:
        resetStyle(s);
        break;
      case 1:
        s.bold = true;
        break;
      case 2:
        s.dim = true;
        break;
      case 3:
        s.italic = true;
        break;
      case 4:
        s.underline = true;
        break;
      case 7:
        s.inverse = true;
        break;
      case 8:
        s.hidden = true;
        break;
      case 9:
        s.strike = true;
        break;
      case 21:
        // Doubly-underlined in ECMA-48 / sometimes "bold off" in legacy. We
        // map to single underline per spec and let the renderer decide.
        s.underline = true;
        break;
      case 22:
        s.bold = false;
        s.dim = false;
        break;
      case 23:
        s.italic = false;
        break;
      case 24:
        s.underline = false;
        break;
      case 27:
        s.inverse = false;
        break;
      case 28:
        s.hidden = false;
        break;
      case 29:
        s.strike = false;
        break;
      case 38: {
        const next = params[i + 1];
        if (next === undefined) {
          i = params.length;
          break;
        }
        const { color, consumed } = parseExtendedColor(params, i + 1);
        if (color !== undefined) s.fg = color;
        i += consumed;
        break;
      }
      case 39:
        s.fg = { kind: 'default' };
        break;
      case 48: {
        const next = params[i + 1];
        if (next === undefined) {
          i = params.length;
          break;
        }
        const { color, consumed } = parseExtendedColor(params, i + 1);
        if (color !== undefined) s.bg = color;
        i += consumed;
        break;
      }
      case 49:
        s.bg = { kind: 'default' };
        break;
      default:
        if (p >= 30 && p <= 37) s.fg = namedFg(p);
        else if (p >= 40 && p <= 47) s.bg = namedBg(p);
        else if (p >= 90 && p <= 97) s.fg = brightFg(p);
        else if (p >= 100 && p <= 107) s.bg = brightBg(p);
        // Unknown / out-of-scope codes are silently skipped.
        break;
    }
    i += 1;
  }
}
