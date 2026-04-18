/**
 * Edge-case coverage for sparse / boundary CSI inputs.
 *
 * These tests lock in the parser's current behavior for scenarios that are
 * rare in real terminal output but trip careless FSMs:
 *
 *   - `ESC[m` (bare CSI with no params, no final between) → treated as `ESC[0m`
 *   - `ESC[` flushed with no final byte → textBuf still flushes on drain,
 *     stray state is dropped without emitting garbage.
 *   - `ESC[?1049h` followed by text → CSI private-mode is dropped; text lands.
 *   - `ESC[1;;2m` with empty slot → empty slot is interpreted as `0`
 *     (reset) per xterm behavior.
 *   - Truecolor with `:` sub-parameter form (`38:2::R:G:B`) — this is a
 *     KNOWN LIMITATION: our parser treats `:` as `;`, which maps the empty
 *     colorspace slot into `0` and shifts the RGB by one. Vanishingly rare
 *     in the wild; locked in with a TODO so a future fix comes with a visible
 *     test diff rather than silently changing behavior.
 */

import { describe, expect, it } from 'vitest';
import { AnsiParser } from '../parser.js';
import type { AnsiSpan } from '../types.js';

const enc = new TextEncoder();
function parse(input: string): AnsiSpan[] {
  const p = new AnsiParser();
  const out = p.feed(enc.encode(input));
  return [...out, ...p.flush()];
}

describe('CSI edge cases', () => {
  it('bare `ESC[m` is treated as reset (ESC[0m)', () => {
    // A run that sets bold, then a bare `m` that should clear, then plain text.
    const spans = parse('\x1b[1mbold\x1b[mplain');
    expect(spans).toEqual([{ text: 'bold', bold: true }, { text: 'plain' }]);
  });

  it('empty slot in SGR params is interpreted as 0 (reset)', () => {
    // `\x1b[1;;2m` → [1, 0, 2]: bold, reset, dim. Effective result is dim
    // (bold was turned on then reset by the 0, then dim applied).
    const spans = parse('\x1b[1;;2mx');
    expect(spans).toEqual([{ text: 'x', dim: true }]);
  });

  it('stray CSI with no final byte is dropped on flush', () => {
    const p = new AnsiParser();
    const first = p.feed(enc.encode('before\x1b[31'));
    // No `m` final yet — parser is still inside CSI; feed does not emit text.
    const afterSecond = p.feed(enc.encode('mred'));
    const tail = p.flush();
    const all = [...first, ...afterSecond, ...tail];
    // Style only applies from `m`. Concatenated text is "before" then "red"
    // carrying the red color.
    const text = all.map((s) => s.text).join('');
    expect(text).toBe('beforered');
    expect(all.some((s) => s.fg?.kind === 'named' && s.fg.index === 1)).toBe(true);
  });

  it('ESC[ left hanging at flush is discarded without emitting garbage', () => {
    const p = new AnsiParser();
    p.feed(enc.encode('txt\x1b['));
    const tail = p.flush();
    // Only "txt" was drained (drained on the ESC boundary in feed); the
    // hanging CSI has no final byte and flush emits nothing further.
    expect(tail.length).toBe(0);
  });

  it('alt-screen private-mode CSI does not interleave with surrounding text', () => {
    // A CSI boundary drains the text buffer (so the style snapshot is
    // correct), which means the spans are fragmented at the ESC bytes. The
    // visible text — concatenated across spans — is still just "ABC".
    const text = parse('A\x1b[?25lB\x1b[?25hC')
      .map((s) => s.text)
      .join('');
    expect(text).toBe('ABC');
  });

  it('sub-parameter colon truecolor (`38:2::R:G:B`) — documented limitation', () => {
    // Known limitation documented at parseSgrParams: `:` is treated identically
    // to `;`, so `38:2::250:0:0` parses as `[38, 2, 0, 250, 0, 0]`. After the
    // truecolor branch consumes 4 elements (mode, r, g, b) the parser then
    // advances to the trailing `0` which triggers a reset. The net effect is
    // that the "red" text carries NO color at all — the applied rgb is
    // clobbered by the trailing reset that the `:` separator turned the
    // spec-legal empty colorspace slot into.
    //
    // This test locks that behavior in — if a future fix adds proper sub-
    // parameter support, the assertion below updates alongside the code
    // change (NOT silently).
    const spans = parse('\x1b[38:2::250:0:0mred');
    const red = spans.find((s) => s.text === 'red');
    expect(red).toBeDefined();
    // CURRENT (limitation): color applied, then clobbered by the trailing 0.
    expect(red?.fg).toBeUndefined();
    // See shared/lib/ansi-parser/parser.ts:parseSgrParams — when `:` becomes
    // a true sub-parameter separator, the colorspace slot no longer injects
    // a stray `0` at the end and the rgb survives.
  });
});
