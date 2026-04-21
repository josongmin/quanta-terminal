import { describe, expect, it } from 'vitest';
import {
  compileQuery,
  findMatchesForQuery,
  findMatchesWithPattern,
  escapeRegex,
  EMPTY_QUERY,
} from '../query.js';

describe('compileQuery', () => {
  it('returns empty for zero-length text', () => {
    const c = compileQuery(EMPTY_QUERY);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.empty).toBe(true);
  });

  it('plain mode is case-insensitive by default', () => {
    const c = compileQuery({
      text: 'Foo',
      regex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    expect(c.ok).toBe(true);
    if (!c.ok || c.empty) throw new Error('expected pattern');
    expect(c.pattern.test('hello FOO bar')).toBe(true);
    expect(c.pattern.flags.includes('i')).toBe(true);
    expect(c.pattern.flags.includes('g')).toBe(true);
  });

  it('case-sensitive toggle drops the i flag', () => {
    const c = compileQuery({
      text: 'Foo',
      regex: false,
      caseSensitive: true,
      wholeWord: false,
    });
    expect(c.ok).toBe(true);
    if (!c.ok || c.empty) throw new Error('expected pattern');
    expect(c.pattern.flags.includes('i')).toBe(false);
    expect(c.pattern.test('hello FOO bar')).toBe(false);
    expect(c.pattern.test('hello Foo bar')).toBe(true);
  });

  it('escapes regex metachars in plain mode', () => {
    const c = compileQuery({
      text: 'a.b(c)',
      regex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    expect(c.ok).toBe(true);
    if (!c.ok || c.empty) throw new Error('expected pattern');
    // Must match literal "a.b(c)", not the regex meaning.
    expect(findMatchesWithPattern('a.b(c) and axb(c)', c.pattern)).toEqual([
      { start: 0, length: 6 },
    ]);
  });

  it('wholeWord wraps pattern in \\b boundaries', () => {
    const c = compileQuery({
      text: 'cat',
      regex: false,
      caseSensitive: false,
      wholeWord: true,
    });
    expect(c.ok).toBe(true);
    if (!c.ok || c.empty) throw new Error('expected pattern');
    // Matches "cat" as a standalone word but NOT "concatenate" / "cats".
    expect(findMatchesWithPattern('cat concatenate cats cat.', c.pattern)).toEqual([
      { start: 0, length: 3 },
      { start: 21, length: 3 },
    ]);
  });

  it('regex mode is passthrough', () => {
    const c = compileQuery({
      text: '\\d+',
      regex: true,
      caseSensitive: false,
      wholeWord: false,
    });
    expect(c.ok).toBe(true);
    if (!c.ok || c.empty) throw new Error('expected pattern');
    expect(findMatchesWithPattern('abc 123 def 4567', c.pattern)).toEqual([
      { start: 4, length: 3 },
      { start: 12, length: 4 },
    ]);
  });

  it('catches invalid regex and returns an error', () => {
    const c = compileQuery({
      text: '[',
      regex: true,
      caseSensitive: false,
      wholeWord: false,
    });
    expect(c.ok).toBe(false);
    if (c.ok) throw new Error('expected error');
    expect(c.error.length).toBeGreaterThan(0);
  });

  it('regex + wholeWord composes boundaries around the pattern', () => {
    const c = compileQuery({
      text: 'h(ello|i)',
      regex: true,
      caseSensitive: false,
      wholeWord: true,
    });
    expect(c.ok).toBe(true);
    if (!c.ok || c.empty) throw new Error('expected pattern');
    // "hi" matches but "chia" does not.
    expect(findMatchesWithPattern('hi chia hello', c.pattern)).toEqual([
      { start: 0, length: 2 },
      { start: 8, length: 5 },
    ]);
  });
});

describe('findMatchesWithPattern', () => {
  it('returns non-overlapping matches', () => {
    const re = /aa/g;
    expect(findMatchesWithPattern('aaaa', re)).toEqual([
      { start: 0, length: 2 },
      { start: 2, length: 2 },
    ]);
  });

  it('advances past zero-length matches without infinite loop', () => {
    const re = /^/gm;
    // Should terminate without emitting overlapping zero-length hits.
    const hits = findMatchesWithPattern('a\nb\nc', re);
    expect(hits).toEqual([]);
  });
});

describe('findMatchesForQuery', () => {
  it('returns [] on invalid regex', () => {
    const hits = findMatchesForQuery('anything', {
      text: '[',
      regex: true,
      caseSensitive: false,
      wholeWord: false,
    });
    expect(hits).toEqual([]);
  });
});

describe('escapeRegex', () => {
  it('escapes all regex metachars', () => {
    expect(escapeRegex('a.b*c+')).toBe('a\\.b\\*c\\+');
    expect(escapeRegex('[x](y)')).toBe('\\[x\\]\\(y\\)');
  });
});
