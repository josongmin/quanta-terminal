/**
 * SOTA unit coverage for `features/command/boundary-detector.ts`.
 *
 * The detector is a stateful suffix-match engine that must locate the mock
 * prompt terminator inside an arbitrary sequence of PTY chunks. The tricky
 * cases are cross-chunk straddles (terminator split across 2, 3, or N feeds)
 * and false-alarm prefixes (bytes that look like the start of the terminator
 * but then diverge, which must be flushed so normal output does not stall).
 *
 * Design notes
 * ------------
 * - Fixtures are built via `Uint8Array.from([...bytes])` against the live
 *   `MOCK_PROMPT_BYTES` constant, so the tests stay tied to the real wire
 *   contract even if the prompt glyph ever changes.
 * - Each test constructs a fresh detector (`createMockBoundaryDetector()`);
 *   the detector is per-block and state carry between tests would hide bugs.
 * - We assert on concrete byte values, not just lengths: the router uses the
 *   returned `preBoundary` bytes verbatim as block content, so any off-by-one
 *   in carry handling would be user-visible.
 */

import { describe, expect, it } from 'vitest';
import { MOCK_PROMPT_BYTES } from '@quanta/host-common';
import { createMockBoundaryDetector } from '../boundary-detector.js';

// ----- Helpers -----

const TERM = MOCK_PROMPT_BYTES;
const TERM_LEN = TERM.length;

/** Build a Uint8Array from a list of byte-sources (numbers, arrays, or
 *  Uint8Arrays). Keeps the test fixtures readable without littering the
 *  specs with `new Uint8Array([...])` boilerplate. */
function bytes(...parts: Array<number | number[] | Uint8Array>): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) {
    if (typeof p === 'number') flat.push(p);
    else if (p instanceof Uint8Array) flat.push(...Array.from(p));
    else flat.push(...p);
  }
  return Uint8Array.from(flat);
}

/** ASCII text → bytes. Only safe for pure ASCII, which is what the test
 *  fixtures use. */
function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Terminator prefix of length `n`. Used for partial / straddle cases. */
function termPrefix(n: number): Uint8Array {
  return TERM.slice(0, n);
}

/** Terminator suffix starting at index `n`. Completes a cross-chunk match
 *  when concatenated with `termPrefix(n)`. */
function termSuffix(n: number): Uint8Array {
  return TERM.slice(n);
}

// Sanity: the whole suite depends on the 11-byte terminator shape.
// If this ever changes, the expected-value constants below need re-derivation.
describe('MOCK_PROMPT_BYTES contract', () => {
  it('is 11 pure-ASCII bytes (ESC [36m $ ESC [0m SPACE)', () => {
    expect(TERM_LEN).toBe(11);
    // ASCII range: every byte < 0x80, so UTF-8 multi-byte sequences never
    // coincide with terminator bytes — the "UTF-8 collision" scenario in
    // the coverage checklist degenerates to plain ASCII safety.
    for (const b of TERM) expect(b).toBeLessThan(0x80);
    expect(Array.from(TERM)).toEqual([0x1b, 0x5b, 0x33, 0x36, 0x6d, 0x24, 0x1b, 0x5b, 0x30, 0x6d, 0x20]);
  });
});

describe('createMockBoundaryDetector — single-chunk scenarios', () => {
  it('returns chunk unchanged when no boundary bytes are present', () => {
    const d = createMockBoundaryDetector();
    const chunk = ascii('hello world');
    const r = d.feed(chunk);
    expect(r.hadBoundary).toBe(false);
    expect(r.exitCode).toBeNull();
    // preBoundary === chunk in content terms. It may or may not be the same
    // reference (implementation detail); assert value equality.
    expect(Array.from(r.preBoundary)).toEqual(Array.from(chunk));
  });

  it('emits empty pre-bytes on an empty feed and stays safe', () => {
    const d = createMockBoundaryDetector();
    const r = d.feed(new Uint8Array(0));
    expect(r.hadBoundary).toBe(false);
    expect(r.preBoundary.length).toBe(0);
    expect(r.exitCode).toBeNull();
  });

  it('detects boundary at the very end of a chunk (pre-bytes = everything before)', () => {
    const d = createMockBoundaryDetector();
    const body = ascii('hello');
    const r = d.feed(bytes(body, TERM));
    expect(r.hadBoundary).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Array.from(r.preBoundary)).toEqual(Array.from(body));
  });

  it('detects boundary at the very start of a chunk (pre-bytes empty)', () => {
    const d = createMockBoundaryDetector();
    const r = d.feed(bytes(TERM));
    expect(r.hadBoundary).toBe(true);
    expect(r.preBoundary.length).toBe(0);
  });

  it('drops post-boundary trailing bytes (earliest-match policy)', () => {
    const d = createMockBoundaryDetector();
    const body = ascii('hello');
    const trail = ascii('ignored');
    const r = d.feed(bytes(body, TERM, trail));
    expect(r.hadBoundary).toBe(true);
    // Trailing bytes are dropped — no active block to route them to.
    expect(Array.from(r.preBoundary)).toEqual(Array.from(body));
  });

  it('takes only the FIRST boundary when a chunk contains multiple terminators', () => {
    const d = createMockBoundaryDetector();
    const r = d.feed(bytes(ascii('a'), TERM, ascii('b'), TERM, ascii('c')));
    expect(r.hadBoundary).toBe(true);
    // Only "a" precedes the first terminator; everything else is dropped.
    expect(Array.from(r.preBoundary)).toEqual(Array.from(ascii('a')));
  });

  it('handles a very large chunk with a boundary buried inside', () => {
    const d = createMockBoundaryDetector();
    // Build a chunk ≫ terminator length so we exercise the inner search loop
    // far past the carry-window edge case.
    const big = new Uint8Array(16 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i % 26) + 0x61; // 'a'..'z'
    const r = d.feed(bytes(big, TERM, ascii('after')));
    expect(r.hadBoundary).toBe(true);
    expect(r.preBoundary.length).toBe(big.length);
    expect(Array.from(r.preBoundary)).toEqual(Array.from(big));
  });
});

describe('createMockBoundaryDetector — cross-chunk straddles', () => {
  it('straddles two chunks: first chunk ends with partial terminator, next chunk completes it', () => {
    const d = createMockBoundaryDetector();
    const body = ascii('hello');
    // First chunk: body + first 5 bytes of terminator (ESC [ 3 6 m).
    const r1 = d.feed(bytes(body, termPrefix(5)));
    expect(r1.hadBoundary).toBe(false);
    // Only the body flushes now; the 5-byte prefix is carried forward.
    expect(Array.from(r1.preBoundary)).toEqual(Array.from(body));

    // Second chunk: remaining 6 bytes of terminator ($ ESC [ 0 m SPACE).
    const r2 = d.feed(termSuffix(5));
    expect(r2.hadBoundary).toBe(true);
    // Nothing precedes the terminator in the combined buffer (carry fills it).
    expect(r2.preBoundary.length).toBe(0);
  });

  it('straddles three chunks: split terminator across 3 feeds with no body', () => {
    const d = createMockBoundaryDetector();
    // Split 11 bytes as 4 / 4 / 3.
    const r1 = d.feed(TERM.slice(0, 4));
    expect(r1.hadBoundary).toBe(false);
    expect(r1.preBoundary.length).toBe(0);

    const r2 = d.feed(TERM.slice(4, 8));
    expect(r2.hadBoundary).toBe(false);
    expect(r2.preBoundary.length).toBe(0);

    const r3 = d.feed(TERM.slice(8));
    expect(r3.hadBoundary).toBe(true);
    expect(r3.preBoundary.length).toBe(0);
  });

  it('straddles every chunk: feed the terminator one byte at a time', () => {
    const d = createMockBoundaryDetector();
    // First 10 bytes are all prefix — detector withholds them all.
    for (let i = 0; i < TERM_LEN - 1; i += 1) {
      const r = d.feed(Uint8Array.from([TERM[i]]));
      expect(r.hadBoundary).toBe(false);
      expect(r.preBoundary.length).toBe(0);
    }
    // Final byte closes the terminator.
    const rLast = d.feed(Uint8Array.from([TERM[TERM_LEN - 1]]));
    expect(rLast.hadBoundary).toBe(true);
    expect(rLast.preBoundary.length).toBe(0);
  });

  it('emits body bytes promptly when partial terminator bytes follow them', () => {
    const d = createMockBoundaryDetector();
    // "abc" + first 3 terminator bytes — body flushes now, 3 bytes carry.
    const r1 = d.feed(bytes(ascii('abc'), termPrefix(3)));
    expect(r1.hadBoundary).toBe(false);
    expect(Array.from(r1.preBoundary)).toEqual(Array.from(ascii('abc')));

    // Finish the terminator on the next feed; carry + rest = full match.
    const r2 = d.feed(termSuffix(3));
    expect(r2.hadBoundary).toBe(true);
    expect(r2.preBoundary.length).toBe(0);
  });
});

describe('createMockBoundaryDetector — false-alarm carry', () => {
  it('flushes carried prefix when subsequent bytes diverge from terminator', () => {
    const d = createMockBoundaryDetector();
    // First 3 terminator bytes look like the start of a match. Carry them.
    const r1 = d.feed(termPrefix(3));
    expect(r1.hadBoundary).toBe(false);
    expect(r1.preBoundary.length).toBe(0);

    // Next chunk starts with non-matching bytes. The carry must be released
    // as real content (not silently dropped) so the block is not truncated.
    const divergent = ascii('XYZ');
    const r2 = d.feed(divergent);
    expect(r2.hadBoundary).toBe(false);
    // preBoundary contains the carried prefix + the divergent bytes.
    expect(Array.from(r2.preBoundary)).toEqual([...termPrefix(3), ...divergent]);
  });

  it('false-alarm then genuine boundary: carried prefix flushes, later terminator matches', () => {
    const d = createMockBoundaryDetector();
    const r1 = d.feed(termPrefix(4)); // looks promising — carry 4 bytes
    expect(r1.hadBoundary).toBe(false);
    expect(r1.preBoundary.length).toBe(0);

    // Divergent byte kills the cross-chunk match, then a fresh "hi" + real
    // terminator arrives all in one feed.
    const r2 = d.feed(bytes(ascii('Q'), ascii('hi'), TERM));
    expect(r2.hadBoundary).toBe(true);
    // preBoundary = carried 4 bytes + "Q" + "hi".
    expect(Array.from(r2.preBoundary)).toEqual([
      ...termPrefix(4),
      ...ascii('Q'),
      ...ascii('hi'),
    ]);
  });

  it('carries only the LONGEST proper terminator prefix that matches a suffix of buffer', () => {
    const d = createMockBoundaryDetector();
    // Feed 10 bytes where the trailing 1 byte equals terminator[0] (ESC).
    // The buffer suffix "ESC" matches a 1-byte prefix of the terminator, so
    // exactly 1 byte must carry and the other 9 flush.
    const body = bytes(ascii('abcdefghi'), Uint8Array.from([TERM[0]]));
    const r = d.feed(body);
    expect(r.hadBoundary).toBe(false);
    expect(Array.from(r.preBoundary)).toEqual(Array.from(ascii('abcdefghi')));

    // Feed the remaining 10 bytes of the terminator — combined with the
    // 1-byte carry they form a full 11-byte match.
    const r2 = d.feed(TERM.slice(1));
    expect(r2.hadBoundary).toBe(true);
    expect(r2.preBoundary.length).toBe(0);
  });

  it('does not carry bytes that merely appear inside the terminator but not as a prefix', () => {
    const d = createMockBoundaryDetector();
    // '$' is TERM[5] but not TERM[0], so a chunk ending in '$' must carry
    // nothing — '$' alone cannot start a terminator match.
    const r = d.feed(ascii('price: $'));
    expect(r.hadBoundary).toBe(false);
    expect(Array.from(r.preBoundary)).toEqual(Array.from(ascii('price: $')));
  });
});

describe('createMockBoundaryDetector — statefulness & isolation', () => {
  it('is per-instance: a fresh detector does not remember the previous one\'s boundary', () => {
    // First detector sees and consumes a boundary.
    const d1 = createMockBoundaryDetector();
    const r1 = d1.feed(bytes(ascii('first'), TERM));
    expect(r1.hadBoundary).toBe(true);

    // A new detector (per-block contract) starts clean: no stale carry.
    const d2 = createMockBoundaryDetector();
    const r2 = d2.feed(ascii('second'));
    expect(r2.hadBoundary).toBe(false);
    expect(Array.from(r2.preBoundary)).toEqual(Array.from(ascii('second')));
  });

  it('after emitting a boundary, subsequent feeds on the same detector start fresh', () => {
    // The router opens a NEW detector per block, but the contract says any
    // further feeds on the same instance must behave as if carry is cleared.
    // (Otherwise a stale carry could corrupt the next block if the caller
    // reused the instance.)
    const d = createMockBoundaryDetector();
    const r1 = d.feed(bytes(ascii('a'), TERM));
    expect(r1.hadBoundary).toBe(true);

    // Feeding a partial prefix now must behave like the very first feed:
    // carry it, do not match against stale state.
    const r2 = d.feed(termPrefix(3));
    expect(r2.hadBoundary).toBe(false);
    expect(r2.preBoundary.length).toBe(0);

    // Completing the terminator now matches cleanly.
    const r3 = d.feed(termSuffix(3));
    expect(r3.hadBoundary).toBe(true);
    expect(r3.preBoundary.length).toBe(0);
  });

  it('interleaves several empty feeds without mutating carry or false-signaling', () => {
    const d = createMockBoundaryDetector();
    const r1 = d.feed(termPrefix(2)); // carry 2
    expect(r1.hadBoundary).toBe(false);

    // Several empty feeds must not drop the carry or signal a boundary.
    for (let i = 0; i < 3; i += 1) {
      const r = d.feed(new Uint8Array(0));
      expect(r.hadBoundary).toBe(false);
      expect(r.preBoundary.length).toBe(0);
    }

    // Carry is still intact — completing the terminator still works.
    const rFinal = d.feed(termSuffix(2));
    expect(rFinal.hadBoundary).toBe(true);
    expect(rFinal.preBoundary.length).toBe(0);
  });
});

describe('createMockBoundaryDetector — byte-safety invariants', () => {
  it('returns a typed-array (not number[] or string) for preBoundary', () => {
    const d = createMockBoundaryDetector();
    const r = d.feed(ascii('hi'));
    // NB: under jsdom, Uint8Array crosses realms and `instanceof Uint8Array`
    // can be false for cross-realm instances. Check the tag instead — this
    // still catches regressions to `number[]`, strings, etc.
    expect(Object.prototype.toString.call(r.preBoundary)).toBe('[object Uint8Array]');
    expect(typeof r.preBoundary.byteLength).toBe('number');
    expect(r.preBoundary.BYTES_PER_ELEMENT).toBe(1);
  });

  it('exitCode is always null for the mock detector', () => {
    const d = createMockBoundaryDetector();
    // No-match path.
    expect(d.feed(ascii('foo')).exitCode).toBeNull();
    // Match path.
    expect(d.feed(bytes(ascii('x'), TERM)).exitCode).toBeNull();
  });

  it('preserves high-ASCII / binary bytes verbatim in preBoundary', () => {
    const d = createMockBoundaryDetector();
    // Bytes 0x80..0xFF never appear in the terminator (pure ASCII), so they
    // must pass through untouched, including as the final byte of a chunk.
    const payload = Uint8Array.from([0x00, 0xff, 0x80, 0x7f, 0xc3, 0xa9]);
    const r = d.feed(payload);
    expect(r.hadBoundary).toBe(false);
    expect(Array.from(r.preBoundary)).toEqual(Array.from(payload));
  });
});
