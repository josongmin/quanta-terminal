/**
 * Control character policy:
 *   BEL  (0x07) — dropped
 *   BS   (0x08) — preserved as a sentinel (BACKSPACE_MARKER); renderer handles
 *                 visual backspace per its `carriageReturnRewrites` prop.
 *   CR   (0x0d) — preserved as `\r` in text
 *   LF   (0x0a) — preserved as `\n` in text
 *
 * Cursor / erase / alt-screen CSIs are ignored — those belong in xterm, not
 * blocks, per ADR 0008.
 */

import { describe, expect, it } from 'vitest';
import { AnsiParser } from '../parser.js';
import { BACKSPACE_MARKER } from '../types.js';
import type { AnsiSpan } from '../types.js';

const enc = new TextEncoder();
function parse(input: string): AnsiSpan[] {
  const p = new AnsiParser();
  const out = p.feed(enc.encode(input));
  return [...out, ...p.flush()];
}

/**
 * Concatenate text across spans. An escape boundary (even a dropped one like
 * a cursor-move CSI) flushes the current text span; `parse()` therefore
 * legitimately returns multiple same-style spans. For "did we drop this
 * sequence" assertions we only care about the visible text, not boundaries.
 */
function textOf(spans: readonly AnsiSpan[]): string {
  return spans.map((s) => s.text).join('');
}

describe('control characters', () => {
  it('drops BEL', () => {
    expect(parse('a\x07b')).toEqual([{ text: 'ab' }]);
  });

  it('preserves backspace as a sentinel in text', () => {
    expect(parse('ab\x08c')).toEqual([{ text: `ab${BACKSPACE_MARKER}c` }]);
  });

  it('preserves CR and LF verbatim', () => {
    expect(parse('a\rb\nc')).toEqual([{ text: 'a\rb\nc' }]);
  });

  it('drops DCS payload (ESC P ... ESC \\)', () => {
    expect(textOf(parse('before\x1bP0;1|abc\x1b\\after'))).toBe('beforeafter');
  });

  it('drops APC payload (ESC _ ... ESC \\)', () => {
    expect(textOf(parse('x\x1b_secret\x1b\\y'))).toBe('xy');
  });

  it('drops PM payload (ESC ^ ... ESC \\)', () => {
    expect(textOf(parse('x\x1b^hidden\x1b\\y'))).toBe('xy');
  });

  it('DCS can also terminate on BEL (permissive)', () => {
    expect(textOf(parse('a\x1bPpayload\x07b'))).toBe('ab');
  });

  it('ignores cursor movement CSIs (A/B/C/D/H/J/K)', () => {
    // Move cursor, clear line, erase. All CSIs are dropped; CR stays in text.
    expect(textOf(parse('a\x1b[5Cb\x1b[2Kc'))).toBe('abc');
  });

  it('silently drops alt-screen CSIs (?1049h / l)', () => {
    // Block-mode parser ignores alt-screen; the upstream pipeline routes a
    // TUI-bearing block to xterm and never feeds us alt-screen content.
    expect(textOf(parse('\x1b[?1049hHELLO\x1b[?1049l'))).toBe('HELLO');
  });
});
