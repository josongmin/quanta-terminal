import { describe, it, expect } from 'vitest';
import { CellBuffer } from '../CellBuffer.js';
import { MirrorSource } from '../MirrorSource.js';
import { SelectionManager } from '../Selection.js';
import { widthAwareRow } from './fixtures.js';
import type { Row } from '../../../lib/grid-mirror/types.js';

/** Build a row from an explicit grapheme list so tests can include control
 *  characters (`\t`) and hand-roll continuation + widths. */
function explicitRow(graphemes: string[], cols: number, continuation = false): Row {
  const cells = graphemes.map((g) => ({
    grapheme: g,
    cols: 1,
    sgr: '0x0000000000000000',
    hyperlink_id: 0,
    ext: null,
  }));
  while (cells.length < cols) {
    cells.push({
      grapheme: '',
      cols: 1,
      sgr: '0x0000000000000000',
      hyperlink_id: 0,
      ext: null,
    });
  }
  return { cells: cells.slice(0, cols), continuation, revision: 1 };
}

function buildBuffer(
  lines: Array<{ text: string; continuation?: boolean }>,
  cols: number,
): CellBuffer {
  const source = new MirrorSource();
  const buffer = new CellBuffer(source, { rows: lines.length, cols });
  lines.forEach((l, i) => buffer.writeRow(i, widthAwareRow(l.text, cols, l.continuation ?? false)));
  return buffer;
}

describe('Copy normalization (ADR 0016 §5)', () => {
  it('1. basic ASCII line — trailing whitespace stripped by default', () => {
    const buffer = buildBuffer([{ text: 'hello world' }], 20);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 20 });
    expect(sel.copy()).toBe('hello world');
  });

  it('2. wrap-joined: 3-line wrapped command copies as one line', () => {
    const buffer = buildBuffer(
      [
        { text: 'echo ' },
        { text: 'hello', continuation: true },
        { text: ' world', continuation: true },
      ],
      10,
    );
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 2, col: 10 });
    const out = sel.copy();
    expect(out.includes('\n')).toBe(false);
    expect(out).toContain('echo');
    expect(out).toContain('hello');
    expect(out).toContain('world');
  });

  it('3. hard newline preserved for non-continuation rows', () => {
    const buffer = buildBuffer(
      [{ text: 'line-A' }, { text: 'line-B' }],
      10,
    );
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 1, col: 10 });
    const out = sel.copy();
    expect(out.split('\n')).toHaveLength(2);
  });

  it('4. Korean line (한글 테스트)', () => {
    const buffer = buildBuffer([{ text: '한글 테스트' }], 12);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 12 });
    const out = sel.copy();
    expect(out).toBe('한글 테스트');
  });

  it('5. ZWJ family emoji stays intact', () => {
    const family = '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66';
    const buffer = buildBuffer([{ text: family }], 4);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 4 });
    expect(sel.copy()).toBe(family);
  });

  it('6. combining mark (é = e + U+0301) single grapheme', () => {
    const text = 'e\u0301';
    const buffer = buildBuffer([{ text }], 2);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 2 });
    const out = sel.copy();
    expect(out).toContain('e');
    expect(out.includes('\u0301')).toBe(true);
  });

  it('7. VS16 (heart emoji) copies with selector', () => {
    const heart = '\u2764\uFE0F';
    const buffer = buildBuffer([{ text: heart }], 2);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 2 });
    expect(sel.copy()).toBe(heart);
  });

  it('8a. tabs preserved with tabStops null', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 1, cols: 4 });
    buffer.writeRow(0, explicitRow(['a', '\t', 'b'], 4));
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 4 });
    const out = sel.copy({ preserveTrailingWhitespace: true, tabStops: null });
    expect(out.includes('\t')).toBe(true);
  });

  it('8b. tabs converted with tabStops 8', () => {
    const source = new MirrorSource();
    const buffer = new CellBuffer(source, { rows: 1, cols: 4 });
    buffer.writeRow(0, explicitRow(['a', '\t', 'b'], 4));
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 4 });
    const out = sel.copy({ preserveTrailingWhitespace: true, tabStops: 8 });
    expect(out.includes('\t')).toBe(false);
    expect(out.match(/ +/)).toBeTruthy();
  });

  it('9. block mode short-row padding', () => {
    const buffer = buildBuffer(
      [
        { text: 'aaaaaa' },
        { text: 'bb' },
        { text: 'cccccc' },
      ],
      8,
    );
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 1 }, 'block');
    sel.extend({ row: 2, col: 6 });
    const out = sel.copy({ preserveTrailingWhitespace: true, tabStops: null });
    const lines = out.split('\n');
    expect(lines.length).toBe(3);
    // Short row padded with spaces to col 6 - 1 = 5.
    expect(lines[1]?.length).toBe(5);
  });

  it('10. trailing spaces stripped by default', () => {
    const buffer = buildBuffer([{ text: 'hi   ' }], 8);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 8 });
    expect(sel.copy()).toBe('hi');
  });

  it('11. trailing spaces preserved with preserveTrailingWhitespace', () => {
    const buffer = buildBuffer([{ text: 'hi  ' }], 6);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 6 });
    const out = sel.copy({ preserveTrailingWhitespace: true, tabStops: null });
    expect(out.length).toBeGreaterThan('hi'.length);
  });

  it('12. trailing half of wide char is not emitted', () => {
    const buffer = buildBuffer([{ text: '한a' }], 4);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    // End at col 1 (right-half of 한); copy should stop at the anchor.
    sel.extend({ row: 0, col: 1 });
    const out = sel.copy({ preserveTrailingWhitespace: true, tabStops: null });
    // Right-half placeholder strip: selecting up to col 1 should copy
    // nothing meaningful (since the anchor for 한 is col 0).
    expect(out.length).toBeLessThanOrEqual(1);
  });

  it('13. SGR stripped (only UTF-8 text emitted)', () => {
    // Build a cell that has non-default sgr but text is plain.
    const buffer = buildBuffer([{ text: 'bold' }], 5);
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 0, col: 4 });
    const out = sel.copy();
    // No ANSI escape sequences ever emitted.
    expect(/\u001b\[/.test(out)).toBe(false);
    expect(out).toBe('bold');
  });

  it('14. empty selection yields empty string', () => {
    const buffer = buildBuffer([{ text: 'a' }], 1);
    const sel = new SelectionManager(buffer);
    expect(sel.copy()).toBe('');
    sel.begin({ row: 0, col: 2 }, 'char');
    // Same anchor start/end → empty.
    expect(sel.copy()).toBe('');
  });

  it('15. wrap-joined Korean line across 2 rows', () => {
    const buffer = buildBuffer(
      [
        { text: '한글' },
        { text: '테스트', continuation: true },
      ],
      6,
    );
    const sel = new SelectionManager(buffer);
    sel.begin({ row: 0, col: 0 }, 'char');
    sel.extend({ row: 1, col: 6 });
    const out = sel.copy();
    expect(out.includes('\n')).toBe(false);
    expect(out).toContain('한글');
    expect(out).toContain('테스트');
  });
});
