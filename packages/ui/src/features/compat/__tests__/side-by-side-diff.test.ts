/**
 * side-by-side-diff unit tests.
 *
 *   1. identical frames → no diffs.
 *   2. single cell mismatch → exactly one `CellDiff`.
 *   3. cursor row/col mismatch → `CursorDiff`.
 *   4. mode mismatch → `ModeDiff` per disagreeing key.
 *   5. rows/cols mismatch surfaces as a `__dims__` ModeDiff and still
 *      compares the overlapping region.
 *   6. SGR attr mismatch registers as a cell diff even when grapheme matches.
 *   7. countCellDiffs filters to cell entries only.
 *   8. The ring recorder preserves insertion order up to its capacity.
 */

import { describe, expect, it } from 'vitest';
import {
  blankSnapshot,
  countCellDiffs,
  diffFrames,
  type CellSnapshot,
  type FrameSnapshot,
} from '../side-by-side-diff.js';
import { SideBySideRecorder } from '../side-by-side-recorder.js';

function cloneSnapshot(frame: FrameSnapshot): FrameSnapshot {
  return {
    rows: frame.rows,
    cols: frame.cols,
    cells: frame.cells.map((r) => r.map((c) => ({ ...c }))),
    cursor: { ...frame.cursor },
    mode: { ...frame.mode },
  };
}

describe('diffFrames', () => {
  it('returns zero diffs for identical frames', () => {
    const a = blankSnapshot(3, 4);
    const b = cloneSnapshot(a);
    expect(diffFrames(a, b)).toHaveLength(0);
  });

  it('emits a CellDiff for a mismatched grapheme', () => {
    const a = blankSnapshot(2, 3);
    const b = cloneSnapshot(a);
    // Replace (row 1, col 2) in b.
    const row = [...(b.cells[1] ?? [])];
    row[2] = { grapheme: 'X', cols: 1, sgr: '0x0000000000000000', hyperlink_id: 0 };
    (b as { cells: ReadonlyArray<ReadonlyArray<CellSnapshot>> }).cells = [
      b.cells[0] ?? [],
      row,
    ];
    const diffs = diffFrames(a, b);
    expect(countCellDiffs(diffs)).toBe(1);
    const diff = diffs[0];
    if (diff && diff.kind === 'cell') {
      expect(diff.row).toBe(1);
      expect(diff.col).toBe(2);
      expect(diff.xterm.grapheme).toBe('X');
    } else {
      throw new Error('expected a CellDiff');
    }
  });

  it('emits a CursorDiff when cursor coordinates differ', () => {
    const a = blankSnapshot(2, 2);
    const b = cloneSnapshot(a);
    (b.cursor as { row: number }).row = 1;
    const diffs = diffFrames(a, b);
    expect(diffs.some((d) => d.kind === 'cursor')).toBe(true);
  });

  it('emits a ModeDiff per disagreeing mode key', () => {
    const a = blankSnapshot(1, 1);
    const b = cloneSnapshot(a);
    (a.mode as Record<string, unknown>)['alt_screen'] = true;
    (b.mode as Record<string, unknown>)['alt_screen'] = false;
    const diffs = diffFrames(a, b);
    const mode = diffs.find((d) => d.kind === 'mode');
    expect(mode).toBeDefined();
    if (mode && mode.kind === 'mode') {
      expect(mode.mode).toBe('alt_screen');
      expect(mode.canvas).toBe(true);
      expect(mode.xterm).toBe(false);
    }
  });

  it('surfaces row/col dimension mismatches as a __dims__ mode diff', () => {
    const a = blankSnapshot(2, 2);
    const b = blankSnapshot(3, 2);
    const diffs = diffFrames(a, b);
    expect(diffs.some((d) => d.kind === 'mode' && d.mode === '__dims__')).toBe(true);
  });

  it('treats an SGR mismatch as a cell diff', () => {
    const a = blankSnapshot(1, 2);
    const b = cloneSnapshot(a);
    const row = [...(b.cells[0] ?? [])];
    row[0] = { grapheme: '', cols: 1, sgr: '0x00FF000000000000', hyperlink_id: 0 };
    (b as { cells: ReadonlyArray<ReadonlyArray<CellSnapshot>> }).cells = [row];
    expect(countCellDiffs(diffFrames(a, b))).toBe(1);
  });
});

describe('SideBySideRecorder', () => {
  it('preserves insertion order up to capacity', () => {
    const rec = new SideBySideRecorder({ capacity: 3 });
    rec.record({ frameAt: 1, diffs: [] });
    rec.record({ frameAt: 2, diffs: [] });
    rec.record({ frameAt: 3, diffs: [] });
    rec.record({ frameAt: 4, diffs: [] });
    const entries = rec.entries();
    expect(entries.map((e) => e.frameAt)).toEqual([2, 3, 4]);
  });

  it('serializes to JSON with a schema tag', () => {
    const rec = new SideBySideRecorder();
    rec.record({ frameAt: 123, diffs: [] });
    const parsed = JSON.parse(rec.exportJson()) as {
      schema: string;
      snapshots: readonly { frameAt: number }[];
    };
    expect(parsed.schema).toBe('side-by-side-diff/1');
    expect(parsed.snapshots[0]?.frameAt).toBe(123);
  });

  it('encodes input-byte diffs as arrays so JSON round-trips', () => {
    const rec = new SideBySideRecorder();
    rec.record({
      frameAt: 1,
      diffs: [
        {
          kind: 'input',
          at: 0,
          canvasBytes: new Uint8Array([65, 66]),
          xtermBytes: new Uint8Array([65, 67]),
        },
      ],
    });
    const parsed = JSON.parse(rec.exportJson()) as {
      snapshots: readonly {
        diffs: readonly { canvasBytes: readonly number[]; xtermBytes: readonly number[] }[];
      }[];
    };
    expect(parsed.snapshots[0]?.diffs[0]?.canvasBytes).toEqual([65, 66]);
    expect(parsed.snapshots[0]?.diffs[0]?.xtermBytes).toEqual([65, 67]);
  });
});
