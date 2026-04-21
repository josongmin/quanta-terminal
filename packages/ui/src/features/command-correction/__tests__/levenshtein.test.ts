import { describe, expect, it } from 'vitest';
import { levenshtein } from '../levenshtein.js';

describe('levenshtein()', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('ls', 'ls')).toBe(0);
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('returns the other length for empty-vs-nonempty inputs', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('computes single-character edits correctly', () => {
    expect(levenshtein('ls', 'lls')).toBe(1); // insertion
    expect(levenshtein('lls', 'ls')).toBe(1); // deletion
    expect(levenshtein('ls', 'la')).toBe(1); // substitution
  });

  it('computes multi-character edits correctly', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('ls', 'git')).toBe(3);
    expect(levenshtein('ehco', 'echo')).toBe(2); // transposition counts as 2 in classic Levenshtein
  });

  it('is symmetric', () => {
    expect(levenshtein('foo', 'bar')).toBe(levenshtein('bar', 'foo'));
    expect(levenshtein('quanta', 'terminal')).toBe(levenshtein('terminal', 'quanta'));
  });

  describe('threshold early-exit', () => {
    it('returns a value greater than threshold when true distance exceeds it', () => {
      const d = levenshtein('abcdef', 'xyz123', 2);
      expect(d).toBeGreaterThan(2);
    });

    it('returns the true distance when it fits under the threshold', () => {
      expect(levenshtein('ls', 'lls', 2)).toBe(1);
      expect(levenshtein('ls', 'lla', 2)).toBe(2);
    });

    it('rejects pairs with large length differences without scanning', () => {
      const d = levenshtein('a', 'abcdefghijk', 2);
      expect(d).toBeGreaterThan(2);
    });

    it('handles distance-0 under any threshold', () => {
      expect(levenshtein('ls', 'ls', 0)).toBe(0);
    });
  });
});
