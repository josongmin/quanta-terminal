import { describe, it, expect } from 'vitest';
import { CellBuffer } from '../CellBuffer.js';
import { HitTest } from '../HitTest.js';
import { MirrorSource } from '../MirrorSource.js';
import { DEFAULT_METRICS } from '../types.js';
import { asciiRow, widthAwareRow } from './fixtures.js';

function build(rows: number, cols: number): {
  buffer: CellBuffer;
  hit: HitTest;
} {
  const source = new MirrorSource();
  const buffer = new CellBuffer(source, { rows, cols });
  for (let r = 0; r < rows; r += 1) buffer.writeRow(r, asciiRow('', cols));
  const hit = new HitTest(buffer, DEFAULT_METRICS);
  return { buffer, hit };
}

describe('HitTest — screenToCell / cellToScreen identity', () => {
  it('property: screenToCell(midpoint(cellToScreen(r,c))) === {r,c} for 120x40', () => {
    const { hit } = build(40, 120);
    for (let r = 0; r < 40; r += 1) {
      for (let c = 0; c < 120; c += 1) {
        const rect = hit.cellToScreen(r, c);
        const xMid = rect.x + rect.width / 2;
        const yMid = rect.y + rect.height / 2;
        const result = hit.screenToCell(xMid, yMid);
        expect(result).not.toBeNull();
        expect(result?.row).toBe(r);
        expect(result?.col).toBe(c);
      }
    }
  });

  it('1000 random cells (property-style)', () => {
    const { hit } = build(40, 120);
    let seed = 0x1234;
    const rng = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 1000; i += 1) {
      const r = Math.floor(rng() * 40);
      const c = Math.floor(rng() * 120);
      const rect = hit.cellToScreen(r, c);
      const result = hit.screenToCell(rect.x + rect.width / 2, rect.y + rect.height / 2);
      expect(result).not.toBeNull();
      expect(result?.row).toBe(r);
      expect(result?.col).toBe(c);
    }
  });
});

describe('HitTest — wide-char half mapping', () => {
  it('right-half of a wide cell maps to the left-half anchor (DoD-D-21)', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 1, cols: 6 });
    buffer.writeRow(0, widthAwareRow('한글', 6));
    const hit = new HitTest(buffer, DEFAULT_METRICS);
    // Left half (col 0): anchor = 0.
    const left = hit.screenToCell(DEFAULT_METRICS.cellWidthCssPx * 0 + 1, 1);
    expect(left?.col).toBe(0);
    // Right half (col 1): same anchor = 0.
    const right = hit.screenToCell(DEFAULT_METRICS.cellWidthCssPx * 1 + 1, 1);
    expect(right?.col).toBe(0);
    // Next cluster (col 2): anchor = 2.
    const next = hit.screenToCell(DEFAULT_METRICS.cellWidthCssPx * 2 + 1, 1);
    expect(next?.col).toBe(2);
  });
});

describe('HitTest — out-of-grid', () => {
  it('negative coords return null', () => {
    const { hit } = build(4, 4);
    expect(hit.screenToCell(-1, 0)).toBeNull();
    expect(hit.screenToCell(0, -1)).toBeNull();
  });

  it('beyond grid height returns null', () => {
    const { hit } = build(4, 4);
    expect(
      hit.screenToCell(0, DEFAULT_METRICS.cellHeightCssPx * 4 + 5),
    ).toBeNull();
  });

  it('past last column on a valid row returns col = cols', () => {
    const { hit } = build(4, 4);
    const result = hit.screenToCell(DEFAULT_METRICS.cellWidthCssPx * 10, 1);
    expect(result?.row).toBe(0);
    expect(result?.col).toBe(4);
  });
});

describe('HitTest — metric updates', () => {
  it('applyMetrics re-scales hit-test', () => {
    const { hit } = build(4, 4);
    const before = hit.screenToCell(8, 8);
    expect(before?.col).toBe(1);
    hit.applyMetrics({
      ...DEFAULT_METRICS,
      cellWidthCssPx: 20,
      cellHeightCssPx: 30,
    });
    const after = hit.screenToCell(8, 8);
    // Now 8px < 20px cell width → col 0.
    expect(after?.col).toBe(0);
  });
});

describe('HitTest — cellToScreen span widths', () => {
  it('wide cell produces 2-cell-wide rect', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 1, cols: 4 });
    buffer.writeRow(0, widthAwareRow('한', 4));
    const hit = new HitTest(buffer, DEFAULT_METRICS);
    const rect = hit.cellToScreen(0, 0);
    expect(rect.width).toBe(DEFAULT_METRICS.cellWidthCssPx * 2);
  });
});
