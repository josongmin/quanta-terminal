/**
 * Streaming invariants.
 *
 * The core contract: feeding the same byte stream in different chunk sizes
 * MUST produce the same concatenated span text (and the same style application).
 * Span boundaries may differ (chunk breaks can introduce extra spans), but
 * concatenating `text` across spans is stable, and the styled output merged
 * back is identical.
 *
 * This test harness fuzzes chunk sizes 1, 2, 4, 17, and "all at once" against
 * a corpus of tricky inputs.
 */

import { describe, expect, it } from 'vitest';
import { AnsiParser } from '../parser.js';
import type { AnsiSpan } from '../types.js';

const enc = new TextEncoder();

function feedInChunks(input: Uint8Array, chunkSize: number): AnsiSpan[] {
  const p = new AnsiParser();
  const out: AnsiSpan[] = [];
  for (let i = 0; i < input.length; i += chunkSize) {
    const slice = input.subarray(i, Math.min(i + chunkSize, input.length));
    out.push(...p.feed(slice));
  }
  out.push(...p.flush());
  return out;
}

/**
 * Normalize: merge adjacent spans with identical styling. A chunk boundary
 * mid-run produces two spans where one-shot parsing would produce one; both
 * are semantically identical and the renderer flattens them the same way.
 */
function merge(spans: readonly AnsiSpan[]): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && styleEq(prev, s)) {
      out[out.length - 1] = { ...prev, text: prev.text + s.text };
      continue;
    }
    out.push(s);
  }
  return out;
}

function styleEq(a: AnsiSpan, b: AnsiSpan): boolean {
  return (
    JSON.stringify({ ...a, text: '' }) === JSON.stringify({ ...b, text: '' })
  );
}

describe('streaming — chunk-size invariance', () => {
  const CORPUS: readonly string[] = [
    'plain text',
    '\x1b[1;31mbold red\x1b[0m normal',
    '\x1b[38;2;12;34;56mtruecolor\x1b[0m',
    '\x1b]8;;https://example.com\x07link\x1b]8;;\x07 after',
    'before\x1bP0|dcs payload\x1b\\after',
    '\x1b[31m\x1b[1m\x1b[4mtriple\x1b[0mplain',
    // realistic grep --color=always --line-number style:
    '\x1b[32m./src/foo.ts\x1b[0m:\x1b[33m42\x1b[0m: matched \x1b[1;31mTODO\x1b[0m here',
  ];

  for (const input of CORPUS) {
    const bytes = enc.encode(input);
    const oneShot = merge(feedInChunks(bytes, bytes.length || 1));

    it.each([1, 2, 4, 17])(`input ${JSON.stringify(input)} parses identically at chunk=%d`, (sz) => {
      const chunked = merge(feedInChunks(bytes, sz));
      expect(chunked).toEqual(oneShot);
    });
  }
});

describe('streaming — UTF-8 split across feeds', () => {
  it('rejoins a 3-byte codepoint split 1+2', () => {
    // 한 = E1 95 9C ... actually "한" (U+D55C) encodes as 0xED 0x95 0x9C.
    const bytes = enc.encode('한');
    expect(bytes).toHaveLength(3);
    const p = new AnsiParser();
    const a = p.feed(bytes.subarray(0, 1));
    const b = p.feed(bytes.subarray(1, 3));
    const c = p.flush();
    const merged = merge([...a, ...b, ...c]);
    expect(merged).toEqual([{ text: '한' }]);
  });

  it('rejoins a 3-byte codepoint split 2+1', () => {
    const bytes = enc.encode('한');
    const p = new AnsiParser();
    const a = p.feed(bytes.subarray(0, 2));
    const b = p.feed(bytes.subarray(2, 3));
    const merged = merge([...a, ...b, ...p.flush()]);
    expect(merged).toEqual([{ text: '한' }]);
  });

  it('handles mixed ASCII + multibyte split across chunks', () => {
    const bytes = enc.encode('a한b');
    const p = new AnsiParser();
    const out: AnsiSpan[] = [];
    // Feed one byte at a time so every possible boundary is exercised.
    for (let i = 0; i < bytes.length; i += 1) {
      out.push(...p.feed(bytes.subarray(i, i + 1)));
    }
    out.push(...p.flush());
    expect(merge(out)).toEqual([{ text: 'a한b' }]);
  });

  it('reset() clears any partial multibyte state', () => {
    const bytes = enc.encode('한');
    const p = new AnsiParser();
    p.feed(bytes.subarray(0, 2));
    p.reset();
    const out = p.feed(enc.encode('hello'));
    const tail = p.flush();
    expect(merge([...out, ...tail])).toEqual([{ text: 'hello' }]);
  });
});

describe('streaming — escape sequence split across feeds', () => {
  it('CSI split between ESC and [', () => {
    const p = new AnsiParser();
    const a = p.feed(new Uint8Array([0x1b]));
    const b = p.feed(enc.encode('[31mred'));
    const c = p.flush();
    const merged = merge([...a, ...b, ...c]);
    expect(merged).toEqual([{ text: 'red', fg: { kind: 'named', index: 1 } }]);
  });

  it('CSI split inside parameter bytes', () => {
    const p = new AnsiParser();
    const a = p.feed(enc.encode('\x1b[38;5;'));
    const b = p.feed(enc.encode('200mx'));
    const merged = merge([...a, ...b, ...p.flush()]);
    expect(merged).toEqual([
      { text: 'x', fg: { kind: 'indexed', index: 200 } },
    ]);
  });

  it('OSC 8 split across many feeds including terminator', () => {
    const p = new AnsiParser();
    const parts = ['\x1b]8;;https://ex', '.com', '\x07lin', 'k\x1b]8;;\x07'];
    const out: AnsiSpan[] = [];
    for (const s of parts) out.push(...p.feed(enc.encode(s)));
    out.push(...p.flush());
    expect(merge(out)).toEqual([{ text: 'link', link: 'https://ex.com' }]);
  });
});
