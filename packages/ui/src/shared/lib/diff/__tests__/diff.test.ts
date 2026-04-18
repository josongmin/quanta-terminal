/**
 * LCS line-diff tests — exercises the 10 rerun fixtures plus the truncation
 * safety rail, the hunk scanner, and the fast paths for empty inputs.
 *
 * The fixtures are intentionally compact (`===`, `+--`, …) so assertion
 * failures print a readable pattern instead of a large DiffLine[] dump.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_LINES_PER_SIDE,
  computeHunks,
  diffLines,
  runDiff,
  splitLines,
  type DiffLine,
} from '../index.js';
import { DIFF_FIXTURES } from '../fixtures.js';

function kindsOf(lines: readonly DiffLine[]): string {
  return lines
    .map((l) => (l.kind === ' ' ? '=' : l.kind))
    .join('');
}

describe('diffLines — fixtures', () => {
  for (const fx of DIFF_FIXTURES) {
    it(`${fx.name}: kind pattern matches`, () => {
      const result = diffLines(fx.left, fx.right);
      expect(kindsOf(result.lines)).toBe(fx.kinds);
      expect(result.didTruncate).toBe(false);
    });
  }
});

describe('diffLines — DiffLine indices', () => {
  it('assigns leftIdx / rightIdx correctly on equal + insert + delete', () => {
    const r = diffLines('a\nb\nc', 'a\nB\nc');
    // Pattern is =-+= per fixture; walk and verify indices.
    expect(r.lines).toEqual<DiffLine[]>([
      { kind: ' ', text: 'a', leftIdx: 0, rightIdx: 0 },
      { kind: '-', text: 'b', leftIdx: 1 },
      { kind: '+', text: 'B', rightIdx: 1 },
      { kind: ' ', text: 'c', leftIdx: 2, rightIdx: 2 },
    ]);
  });

  it('one-sided empty input produces all-insertions', () => {
    const r = diffLines('', 'a\nb');
    expect(r.lines).toEqual<DiffLine[]>([
      { kind: '+', text: 'a', rightIdx: 0 },
      { kind: '+', text: 'b', rightIdx: 1 },
    ]);
  });

  it('empty on right produces all-deletions', () => {
    const r = diffLines('a\nb', '');
    expect(r.lines).toEqual<DiffLine[]>([
      { kind: '-', text: 'a', leftIdx: 0 },
      { kind: '-', text: 'b', leftIdx: 1 },
    ]);
  });
});

describe('splitLines', () => {
  it('drops a single trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
  });
  it('preserves explicit empty lines', () => {
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
  });
  it('empty string yields []', () => {
    expect(splitLines('')).toEqual([]);
  });
});

describe('diffLines — truncation', () => {
  it('flags didTruncate when left exceeds MAX_LINES_PER_SIDE', () => {
    // Generate without a gigantic allocation — we cap the left to MAX+5.
    const N = MAX_LINES_PER_SIDE + 5;
    const leftArr: string[] = new Array(N);
    for (let i = 0; i < N; i += 1) leftArr[i] = `ll${i}`;
    const rightArr: string[] = ['r'];
    // Feed pre-split arrays so we don't pay the giant string concat cost.
    const truncatedLeft = leftArr.slice(0, MAX_LINES_PER_SIDE);
    const lines = runDiff(truncatedLeft, rightArr);
    // Sanity: runDiff treats its inputs as-is, so it sees MAX × 1 — the
    // emitted trace length is MAX deletions + 1 insertion.
    expect(lines.length).toBe(MAX_LINES_PER_SIDE + 1);

    // diffLines integrates the clamp + flag.
    const clampedResult = diffLines(leftArr.join('\n'), rightArr.join('\n'));
    expect(clampedResult.didTruncate).toBe(true);
    expect(clampedResult.leftLineCount).toBe(MAX_LINES_PER_SIDE);
    expect(clampedResult.rightLineCount).toBe(1);
  });

  it('does NOT flag didTruncate when both sides fit', () => {
    const r = diffLines('a\nb\nc', 'a\nc');
    expect(r.didTruncate).toBe(false);
    expect(r.leftLineCount).toBe(3);
    expect(r.rightLineCount).toBe(2);
  });
});

describe('computeHunks', () => {
  it('groups contiguous non-equal lines into hunks', () => {
    const r = diffLines('a\nb\nc\nd\ne', 'a\nB\nc\nD\nE');
    // Expected kinds around: a=, b-, B+, c=, d-, D+, e-, E+ (plus tie-break)
    const hunks = computeHunks(r.lines);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
    for (const h of hunks) {
      for (let i = h.start; i < h.end; i += 1) {
        expect(r.lines[i]?.kind).not.toBe(' ');
      }
    }
  });

  it('returns [] when every line is context', () => {
    const r = diffLines('a\nb\nc', 'a\nb\nc');
    expect(computeHunks(r.lines)).toEqual([]);
  });

  it('returns one hunk spanning the whole diff when fully different', () => {
    const r = diffLines('a\nb', 'x\ny');
    const hunks = computeHunks(r.lines);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({ start: 0, end: r.lines.length });
  });
});
