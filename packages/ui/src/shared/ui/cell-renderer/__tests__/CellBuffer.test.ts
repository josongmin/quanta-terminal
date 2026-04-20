import { describe, it, expect } from 'vitest';
import {
  CellBuffer,
  DEFAULT_ATTRS,
  DEFAULT_COLOR,
  decodeAttrs,
  encodeAttrs,
  formatSgr,
  parseSgr,
  type AttrFlags,
  type Color,
} from '../CellBuffer.js';
import { MirrorSource } from '../MirrorSource.js';
import { asciiRow, widthAwareRow } from './fixtures.js';

describe('CellBuffer — construction & lifecycle', () => {
  it('subscribes on construction and unsubscribes on dispose (leak test)', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 2, cols: 4 });
    expect(source.subscriberCount()).toBe(1);
    buffer.dispose();
    expect(source.subscriberCount()).toBe(0);
  });

  it('dispose is idempotent', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 1, cols: 1 });
    buffer.dispose();
    buffer.dispose();
    expect(source.subscriberCount()).toBe(0);
  });

  it('dimensions round-trip after resize', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source);
    buffer.resize(40, 120);
    expect(buffer.dimensions()).toEqual({ rows: 40, cols: 120 });
    buffer.dispose();
  });

  it('mirror change handler marks rows dirty', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 5, cols: 10 });
    // Initial resize marks every row dirty; drain first.
    buffer.drainDamage();
    source.emit(new Set([1, 3]));
    const drained = buffer.drainDamage();
    expect(drained.rowArray()).toEqual([1, 3]);
    buffer.dispose();
  });
});

describe('CellBuffer — writeRow / getCell', () => {
  it('stores and recovers ASCII cells', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 2, cols: 8 });
    buffer.writeRow(0, asciiRow('Hello', 8));
    expect(buffer.getCell(0, 0)?.grapheme).toBe('H');
    expect(buffer.getCell(0, 4)?.grapheme).toBe('o');
    expect(buffer.getCell(0, 5)?.grapheme).toBe('');
    buffer.dispose();
  });

  it('honors semantic width (wide-char stored as 2-col cell)', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 1, cols: 6 });
    buffer.writeRow(0, widthAwareRow('한글', 6));
    const c0 = buffer.getCell(0, 0);
    expect(c0?.grapheme).toBe('한');
    expect(c0?.cols).toBe(2);
    expect(buffer.getCell(0, 1)?.grapheme).toBe('');
    expect(buffer.getCell(0, 2)?.grapheme).toBe('글');
    buffer.dispose();
  });

  it('freezeRow prevents further writes', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 2, cols: 4 });
    buffer.writeRow(0, asciiRow('abcd', 4));
    buffer.freezeRow(0);
    expect(buffer.isFrozen(0)).toBe(true);
    buffer.writeRow(0, asciiRow('EFGH', 4));
    expect(buffer.getCell(0, 0)?.grapheme).toBe('a');
    buffer.dispose();
  });

  it('out-of-range reads return null', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 2, cols: 2 });
    expect(buffer.getCell(-1, 0)).toBeNull();
    expect(buffer.getCell(5, 0)).toBeNull();
    expect(buffer.getCell(0, 99)).toBeNull();
    buffer.dispose();
  });
});

describe('CellBuffer — drainDamage', () => {
  it('resize marks every row dirty; drain then resets', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 3, cols: 2 });
    const first = buffer.drainDamage();
    expect(first.rowArray()).toEqual([0, 1, 2]);
    const second = buffer.drainDamage();
    expect(second.isEmpty()).toBe(true);
    buffer.dispose();
  });

  it('writeRow marks only the written row dirty', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 4, cols: 4 });
    buffer.drainDamage();
    buffer.writeRow(2, asciiRow('abcd', 4));
    const drained = buffer.drainDamage();
    expect(drained.rowArray()).toEqual([2]);
    buffer.dispose();
  });
});

describe('pack/unpack round-trip (property)', () => {
  it('attr flags encode+decode for a random sample', () => {
    for (let i = 0; i < 256; i += 1) {
      const decoded = decodeAttrs(i);
      expect(encodeAttrs(decoded)).toBe(i);
    }
  });

  it('10000 random cells round-trip via SGR string', () => {
    const seed = 42;
    // Simple LCG — deterministic pseudo-random.
    let s = seed;
    const rng = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const kinds: Array<Color['kind']> = ['default', 'palette8', 'palette256', 'truecolor'];
    for (let i = 0; i < 10000; i += 1) {
      const attrs: AttrFlags = {
        bold: rng() < 0.5,
        italic: rng() < 0.5,
        underline: rng() < 0.5,
        blink: rng() < 0.3,
        inverse: rng() < 0.3,
        strike: rng() < 0.1,
        faint: rng() < 0.1,
        doubleUnderline: rng() < 0.05,
      };
      const fgKind = kinds[Math.floor(rng() * kinds.length)] ?? 'default';
      const bgKind = kinds[Math.floor(rng() * kinds.length)] ?? 'default';
      const fg: Color = {
        kind: fgKind,
        palette: Math.floor(rng() * 64),
        rgb: fgKind === 'truecolor' ? Math.floor(rng() * 0xffffff) : 0,
      };
      const bg: Color = {
        kind: bgKind,
        palette: Math.floor(rng() * 64),
        rgb: bgKind === 'truecolor' ? Math.floor(rng() * 0xffff) : 0,
      };
      const sgr = formatSgr(attrs, fg, bg);
      const parsed = parseSgr(sgr);
      expect(parsed.attrs).toEqual(attrs);
      // palette round-trips for palette kinds (up to 6 bits for some paths).
      if (fgKind !== 'default') expect(parsed.fg.kind).toBe(fgKind);
      if (bgKind !== 'default') expect(parsed.bg.kind).toBe(bgKind);
    }
  });

  it('SGR default value round-trips', () => {
    const hex = formatSgr(DEFAULT_ATTRS, DEFAULT_COLOR, DEFAULT_COLOR);
    const parsed = parseSgr(hex);
    expect(parsed.attrs).toEqual(DEFAULT_ATTRS);
    expect(parsed.fg.kind).toBe('default');
    expect(parsed.bg.kind).toBe('default');
  });
});

describe('CellBuffer — getRowCells / isContinuation', () => {
  it('getRowCells returns a subarray view', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 3, cols: 4 });
    buffer.writeRow(1, asciiRow('abcd', 4));
    const { packed, continuation } = buffer.getRowCells(1);
    expect(packed.length).toBe(4);
    expect(continuation).toBe(false);
    buffer.dispose();
  });

  it('continuation flag preserved across writes', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 2, cols: 4 });
    const wrapped = { ...asciiRow('abcd', 4), continuation: true };
    buffer.writeRow(0, wrapped);
    expect(buffer.isContinuation(0)).toBe(true);
    expect(buffer.isContinuation(1)).toBe(false);
    buffer.dispose();
  });
});

describe('CellBuffer — writeSnapshot dimensions', () => {
  it('grows both rows and cols when the snapshot is larger', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 2, cols: 4 });
    buffer.writeSnapshot([asciiRow('hello', 8), asciiRow('world', 8), asciiRow('!!!', 8)]);
    expect(buffer.dimensions()).toEqual({ rows: 3, cols: 8 });
    expect(buffer.getCell(0, 0)?.grapheme).toBe('h');
    expect(buffer.getCell(2, 0)?.grapheme).toBe('!');
    buffer.dispose();
  });

  it('shrinks rows AND cols when the snapshot is smaller (authoritative dims)', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 6, cols: 20 });
    // Snapshot at 3×8 — both axes must shrink.
    buffer.writeSnapshot([
      asciiRow('abc', 8),
      asciiRow('def', 8),
      asciiRow('ghi', 8),
    ]);
    expect(buffer.dimensions()).toEqual({ rows: 3, cols: 8 });
    // Out-of-range read past the shrunk cols yields null, not a residue cell.
    expect(buffer.getCell(0, 10)).toBeNull();
    expect(buffer.getCell(5, 0)).toBeNull();
    expect(buffer.getCell(0, 0)?.grapheme).toBe('a');
    buffer.dispose();
  });

  it('keeps existing cols when the snapshot has zero rows (no-op width)', () => {
    // Guard: a stray 0-row snapshot must not wipe the buffer's cols to 0 (which
    // would blow up renderer indexing). rows go to 0, cols hold.
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 3, cols: 12 });
    buffer.writeSnapshot([]);
    expect(buffer.dimensions()).toEqual({ rows: 0, cols: 12 });
    buffer.dispose();
  });

  it('row-count mismatch alone still triggers a resize (even when cols stays the same)', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 4, cols: 8 });
    buffer.writeSnapshot([asciiRow('a', 8)]);
    expect(buffer.dimensions()).toEqual({ rows: 1, cols: 8 });
    buffer.dispose();
  });

  it('cols-only shrink at the same row count propagates (mirror-authority parity)', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 2, cols: 16 });
    // Row count unchanged but cols drops — buffer must follow.
    buffer.writeSnapshot([asciiRow('xy', 4), asciiRow('zw', 4)]);
    expect(buffer.dimensions()).toEqual({ rows: 2, cols: 4 });
    // Out-of-range read on the old-cols index must be null.
    expect(buffer.getCell(0, 10)).toBeNull();
    expect(buffer.getCell(0, 0)?.grapheme).toBe('x');
    buffer.dispose();
  });
});
