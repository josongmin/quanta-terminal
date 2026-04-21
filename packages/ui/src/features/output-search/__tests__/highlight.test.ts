import { describe, expect, it } from 'vitest';
import { distributeRangesToSpans, findMatches } from '../highlight.js';

describe('findMatches', () => {
  it('returns [] for empty query or empty text', () => {
    expect(findMatches('', 'foo')).toEqual([]);
    expect(findMatches('hello', '')).toEqual([]);
  });

  it('finds a single occurrence', () => {
    expect(findMatches('hello world', 'world')).toEqual([{ start: 6, length: 5 }]);
  });

  it('finds multiple non-overlapping occurrences', () => {
    expect(findMatches('foo bar foo baz foo', 'foo')).toEqual([
      { start: 0, length: 3 },
      { start: 8, length: 3 },
      { start: 16, length: 3 },
    ]);
  });

  it('is case-insensitive', () => {
    expect(findMatches('HELLO hello HeLLo', 'hello')).toEqual([
      { start: 0, length: 5 },
      { start: 6, length: 5 },
      { start: 12, length: 5 },
    ]);
  });

  it('skips overlapping matches idiomatically (aaa vs aa)', () => {
    // "aaaa" contains "aa" at 0 and 2 — not 1 or 3.
    expect(findMatches('aaaa', 'aa')).toEqual([
      { start: 0, length: 2 },
      { start: 2, length: 2 },
    ]);
  });
});

describe('distributeRangesToSpans', () => {
  it('returns empty arrays when no ranges', () => {
    const out = distributeRangesToSpans(['abc', 'def'], []);
    expect(out).toEqual([[], []]);
  });

  it('assigns a match fully inside one span', () => {
    // "hello world" split as ['hel','lo ','world'] — match "world" is at 6..11
    const out = distributeRangesToSpans(
      ['hel', 'lo ', 'world'],
      [{ start: 6, length: 5 }],
    );
    expect(out).toEqual([[], [], [{ start: 0, length: 5 }]]);
  });

  it('splits a match across multiple spans', () => {
    // "hello" split as ['he','ll','o'] — match "hello" 0..5 straddles all three
    const out = distributeRangesToSpans(
      ['he', 'll', 'o'],
      [{ start: 0, length: 5 }],
    );
    expect(out).toEqual([
      [{ start: 0, length: 2 }],
      [{ start: 0, length: 2 }],
      [{ start: 0, length: 1 }],
    ]);
  });

  it('handles multiple ranges in a single span', () => {
    // "foo bar foo" single-span
    const out = distributeRangesToSpans(
      ['foo bar foo'],
      [
        { start: 0, length: 3 },
        { start: 8, length: 3 },
      ],
    );
    expect(out).toEqual([
      [
        { start: 0, length: 3 },
        { start: 8, length: 3 },
      ],
    ]);
  });

  it('skips out-of-bounds ranges gracefully', () => {
    const out = distributeRangesToSpans(
      ['abc'],
      [{ start: 10, length: 3 }],
    );
    expect(out).toEqual([[]]);
  });
});
