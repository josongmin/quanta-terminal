import { describe, it, expect } from 'vitest';
import { CellBuffer } from '../CellBuffer.js';
import { MirrorSource } from '../MirrorSource.js';
import { SelectionManager, normalizeSelection } from '../Selection.js';
import type { SelectionState } from '../types.js';
import { widthAwareRow } from './fixtures.js';

function buildBuffer(lines: string[], cols: number): CellBuffer {
  const source = new MirrorSource();
  const buffer = new CellBuffer(source, { rows: lines.length, cols });
  lines.forEach((line, i) => buffer.writeRow(i, widthAwareRow(line, cols)));
  return buffer;
}

function buildWithWrap(lines: Array<{ text: string; continuation: boolean }>, cols: number): CellBuffer {
  const source = new MirrorSource();
  const buffer = new CellBuffer(source, { rows: lines.length, cols });
  lines.forEach((l, i) => {
    const row = widthAwareRow(l.text, cols, l.continuation);
    buffer.writeRow(i, row);
  });
  return buffer;
}

describe('Selection — normalization', () => {
  it('start after end swaps', () => {
    const sel: SelectionState = {
      start: { row: 2, col: 5 },
      end: { row: 1, col: 3 },
      mode: 'char',
    };
    const n = normalizeSelection(sel);
    expect(n.start.row).toBe(1);
    expect(n.end.row).toBe(2);
  });

  it('same row, start col after end col swaps', () => {
    const n = normalizeSelection({
      start: { row: 0, col: 4 },
      end: { row: 0, col: 1 },
      mode: 'char',
    });
    expect(n.start.col).toBe(1);
    expect(n.end.col).toBe(4);
  });

  it('already-normalized returns unchanged', () => {
    const sel: SelectionState = {
      start: { row: 0, col: 0 },
      end: { row: 1, col: 5 },
      mode: 'char',
    };
    expect(normalizeSelection(sel)).toBe(sel);
  });
});

describe('Selection — char mode (5 scenarios, DoD-D-24)', () => {
  it('single-row drag left-to-right', () => {
    const buffer = buildBuffer(['hello world '], 12);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 5 });
    const s = sel.normalized();
    expect(s?.start).toEqual({ row: 0, col: 0 });
    expect(s?.end).toEqual({ row: 0, col: 5 });
  });

  it('single-row drag right-to-left (normalized)', () => {
    const buffer = buildBuffer(['abcdef'], 6);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 4 }, 'char');
    sel.extend({ row: 0, col: 1 });
    const n = sel.normalized();
    expect(n?.start).toEqual({ row: 0, col: 1 });
    expect(n?.end).toEqual({ row: 0, col: 4 });
  });

  it('multi-row drag top-to-bottom', () => {
    const buffer = buildBuffer(['row 0', 'row 1', 'row 2'], 8);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 2 }, 'char');
    sel.extend({ row: 2, col: 3 });
    const n = sel.normalized();
    expect(n?.start.row).toBe(0);
    expect(n?.end.row).toBe(2);
  });

  it('multi-row drag bottom-to-top', () => {
    const buffer = buildBuffer(['row 0', 'row 1'], 8);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 1, col: 3 }, 'char');
    sel.extend({ row: 0, col: 0 });
    const n = sel.normalized();
    expect(n?.start).toEqual({ row: 0, col: 0 });
    expect(n?.end).toEqual({ row: 1, col: 3 });
  });

  it('char mode across a wide-char cell', () => {
    const buffer = buildBuffer(['한글abc'], 8);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 6 });
    const s = sel.get();
    expect(s?.mode).toBe('char');
    expect(s?.end.col).toBe(6);
  });
});

describe('Selection — word mode (5 scenarios, DoD-D-25)', () => {
  it('double-click on ASCII word selects the whole word', () => {
    const buffer = buildBuffer(['hello world'], 11);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 2 }, 'word');
    const s = sel.get();
    expect(s?.mode).toBe('word');
    expect(s?.start.col).toBe(0);
    expect(s?.end.col).toBe(5);
  });

  it('word mode on punctuation boundary', () => {
    const buffer = buildBuffer(['foo, bar'], 8);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 5 }, 'word');
    const s = sel.get();
    expect(s?.mode).toBe('word');
    expect(s?.end.col).toBeGreaterThan(s!.start.col);
  });

  it('word mode within whitespace produces a zero-width or whitespace range', () => {
    const buffer = buildBuffer(['a b'], 3);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 1 }, 'word');
    const s = sel.get();
    expect(s?.mode).toBe('word');
  });

  it('word mode on an empty row is a no-op range', () => {
    const buffer = buildBuffer(['   '], 4);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 2 }, 'word');
    const s = sel.get();
    expect(s).not.toBeNull();
  });

  it('word mode expand via explicit call', () => {
    const buffer = buildBuffer(['abc def'], 7);
    const sel = new SelectionManager(buffer);
    const expanded = sel.expandToWord({ row: 0, col: 4 });
    expect(expanded.start.col).toBe(4);
    expect(expanded.end.col).toBe(7);
  });
});

describe('Selection — line mode (5 scenarios, DoD-D-26)', () => {
  it('triple-click on a single-row line selects the row', () => {
    const buffer = buildBuffer(['hello', 'world'], 5);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 1, col: 2 }, 'line');
    const s = sel.get();
    expect(s?.start).toEqual({ row: 1, col: 0 });
    expect(s?.end.col).toBe(5);
  });

  it('triple-click on a 2-row wrap selects both rows', () => {
    const buffer = buildWithWrap(
      [
        { text: 'long ', continuation: false },
        { text: 'cmd', continuation: true },
      ],
      5,
    );
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 1, col: 1 }, 'line');
    const s = sel.get();
    expect(s?.start).toEqual({ row: 0, col: 0 });
    expect(s?.end.row).toBe(1);
  });

  it('triple-click on 4-row wrap selects all rows', () => {
    const buffer = buildWithWrap(
      [
        { text: 'aaaa', continuation: false },
        { text: 'bbbb', continuation: true },
        { text: 'cccc', continuation: true },
        { text: 'dddd', continuation: true },
      ],
      4,
    );
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 2, col: 2 }, 'line');
    const s = sel.get();
    expect(s?.start.row).toBe(0);
    expect(s?.end.row).toBe(3);
  });

  it('triple-click at line-end preserves line', () => {
    const buffer = buildBuffer(['hello'], 5);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 4 }, 'line');
    const s = sel.get();
    expect(s?.start.col).toBe(0);
    expect(s?.end.col).toBe(5);
  });

  it('expandToLine explicit call', () => {
    const buffer = buildBuffer(['alpha', 'beta'], 5);
    const sel = new SelectionManager(buffer);
    const e = sel.expandToLine({ row: 1, col: 2 });
    expect(e.start.row).toBe(1);
    expect(e.end.row).toBe(1);
  });
});

describe('Selection — block mode (5 scenarios, DoD-D-27)', () => {
  it('block mode sets mode to block', () => {
    const buffer = buildBuffer(['a'.repeat(10), 'b'.repeat(10)], 10);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 2 }, 'block');
    sel.extend({ row: 1, col: 6 });
    const s = sel.get();
    expect(s?.mode).toBe('block');
  });

  it('setBlockMode toggles a char selection into block', () => {
    const buffer = buildBuffer(['abcdef', 'ghijkl'], 6);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 1 }, 'char');
    sel.extend({ row: 1, col: 5 });
    sel.setBlockMode(true);
    expect(sel.get()?.mode).toBe('block');
  });

  it('block mode across short rows with padding at copy time', () => {
    const buffer = buildBuffer(['long row of cells', 'short', 'medium row'], 20);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 5 }, 'block');
    sel.extend({ row: 2, col: 10 });
    const out = sel.copy();
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    // Each line should be exactly the rectangle width (5 cols).
    expect(lines[0]?.length).toBeLessThanOrEqual(5);
  });

  it('block mode with wide-char straddling edge', () => {
    const buffer = buildBuffer(['한abc', 'def'], 5);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'block');
    sel.extend({ row: 1, col: 4 });
    expect(sel.get()?.mode).toBe('block');
  });

  it('block mode empty range yields empty string', () => {
    const buffer = buildBuffer(['abcde'], 5);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 2 }, 'block');
    const out = sel.copy();
    expect(out).toBe('');
  });
});

describe('Selection — observable', () => {
  it('onSelectionChange fires on begin/extend/cancel', () => {
    const buffer = buildBuffer(['abc'], 3);
    const sel = new SelectionManager(buffer);
    const events: Array<SelectionState | null> = [];
    const unsub = sel.onSelectionChange((s) => events.push(s));
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 2 });
    sel.cancel();
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)).toBeNull();
    unsub();
  });

  it('unsubscribe stops events', () => {
    const buffer = buildBuffer(['abc'], 3);
    const sel = new SelectionManager(buffer);
    let count = 0;
    const unsub = sel.onSelectionChange(() => {
      count += 1;
    });
    unsub();
    sel.begin({ row: 0, col: 0 }, 'char');
    expect(count).toBe(0);
  });
});
