/**
 * Unit tests for the VtEmulator byte→grid converter.
 *
 * Strategy:
 *   - Build an emulator with a small grid (80x24 is too tall to stare at).
 *   - Collect emitted envelopes in a local array via `onEnvelope`.
 *   - Assert against internal grid state (`_getCell`, `_getCursor`) for
 *     most behavior, and against the envelope sequence for contract-level
 *     properties (snapshot on construction, delta on feed, cursor_moved
 *     for cursor-only changes, resize_generation on resize()).
 *
 * Everything here is UTF-8 byte-level — we call `feed(new TextEncoder().encode(s))`
 * so the tests look like the bytes a real PTY would emit.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../VtEmulator.js';
import type {
  GridDeltaPayload,
  GridEventEnvelope,
  GridPayload,
  GridSnapshotPayload,
  CursorMovedPayload,
} from '../../grid-mirror/types.js';

type Env = GridEventEnvelope<GridPayload>;

/** Tiny harness that eats envelopes and exposes convenience accessors. */
class Harness {
  readonly envs: Env[] = [];
  readonly emulator: VtEmulator;

  constructor(rows = 6, cols = 10, sessionId = 'test-session') {
    this.emulator = new VtEmulator({
      sessionId,
      rows,
      cols,
      onEnvelope: (env) => this.envs.push(env),
    });
  }

  feed(s: string | Uint8Array): void {
    const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : s;
    this.emulator.feed(bytes);
  }

  lastEnvOfKind<K extends GridPayload['kind']>(
    kind: K,
  ): (Env & { payload: Extract<GridPayload, { kind: K }> }) | undefined {
    for (let i = this.envs.length - 1; i >= 0; i -= 1) {
      const env = this.envs[i];
      if (env && env.payload.kind === kind) {
        return env as Env & { payload: Extract<GridPayload, { kind: K }> };
      }
    }
    return undefined;
  }

  /** Reset the envelope log (useful after setup phases). */
  clearEnvs(): void {
    this.envs.length = 0;
  }

  /** Get the grapheme at (row, col) for assertions. */
  cellGrapheme(row: number, col: number): string {
    return this.emulator._getCell(row, col)?.grapheme ?? '';
  }

  /** Reconstruct a row as a string by joining cell graphemes (blank → ' '). */
  rowText(row: number): string {
    const { cols } = this.emulator.getDimensions();
    let out = '';
    for (let c = 0; c < cols; c += 1) {
      const cell = this.emulator._getCell(row, c);
      if (!cell) {
        out += ' ';
        continue;
      }
      if (cell.width === 0) continue; // wide continuation, skip
      out += cell.grapheme === '' ? ' ' : cell.grapheme;
    }
    return out;
  }
}

describe('VtEmulator — construction + snapshot', () => {
  it('emits a grid_snapshot on construction', () => {
    const h = new Harness(4, 6);
    expect(h.envs).toHaveLength(1);
    const env = h.envs[0]!;
    expect(env.payload.kind).toBe('grid_snapshot');
    const payload = env.payload as GridSnapshotPayload;
    expect(payload.rows).toBe(4);
    expect(payload.cols).toBe(6);
    expect(payload.row_deltas).toHaveLength(4);
  });

  it('defaults to 24x80 when no dimensions given', () => {
    const h = new Harness();
    // Override: need default dims
    const h2 = new VtEmulator({ onEnvelope: () => undefined });
    expect(h2.getDimensions()).toEqual({ rows: 24, cols: 80 });
    void h;
  });

  it('initial snapshot has sequence_no=1 and epoch=1', () => {
    const h = new Harness(3, 4);
    const env = h.envs[0]!;
    expect(env.sequence_no).toBe(1);
    expect(env.grid_epoch).toBe(1);
  });

  it('carries sessionId through the envelope', () => {
    const h = new Harness(3, 4, 'abc-123');
    expect(h.envs[0]!.session_id).toBe('abc-123');
  });
});

describe('VtEmulator — plain text', () => {
  it('writes ASCII "abc" into the first row', () => {
    const h = new Harness(3, 8);
    h.clearEnvs();
    h.feed('abc');
    expect(h.cellGrapheme(0, 0)).toBe('a');
    expect(h.cellGrapheme(0, 1)).toBe('b');
    expect(h.cellGrapheme(0, 2)).toBe('c');
    expect(h.emulator._getCursor().col).toBe(3);
  });

  it('emits a grid_delta on feed', () => {
    const h = new Harness(3, 8);
    h.clearEnvs();
    h.feed('xy');
    const delta = h.lastEnvOfKind('grid_delta');
    expect(delta).toBeDefined();
    expect(delta!.payload.row_deltas).toHaveLength(1);
    expect(delta!.payload.row_deltas[0]!.row).toBe(0);
  });

  it('handles CR — col returns to 0', () => {
    const h = new Harness(3, 8);
    h.feed('ab\rc');
    expect(h.cellGrapheme(0, 0)).toBe('c');
    expect(h.cellGrapheme(0, 1)).toBe('b');
    expect(h.emulator._getCursor().col).toBe(1);
  });

  it('handles LF — row +=1 within scroll region', () => {
    const h = new Harness(3, 8);
    h.feed('a\nb');
    expect(h.emulator._getCursor().row).toBe(1);
    expect(h.cellGrapheme(1, 1)).toBe('b');
  });

  it('handles CR+LF combo after content', () => {
    const h = new Harness(3, 8);
    h.feed('hello\r\nworld');
    expect(h.rowText(0).trim()).toBe('hello');
    expect(h.rowText(1).trim()).toBe('world');
  });

  it('handles TAB — cursor jumps to next 8-stop', () => {
    const h = new Harness(3, 16);
    h.feed('a\t');
    expect(h.emulator._getCursor().col).toBe(8);
  });

  it('handles BS — cursor col -= 1, col >= 0', () => {
    const h = new Harness(3, 8);
    h.feed('abc\b');
    expect(h.emulator._getCursor().col).toBe(2);
    // BS at col 0 clamps at 0.
    h.feed('\r\b');
    expect(h.emulator._getCursor().col).toBe(0);
  });

  it('drops BEL without affecting cursor', () => {
    const h = new Harness(3, 8);
    h.feed('a\x07b');
    expect(h.cellGrapheme(0, 0)).toBe('a');
    expect(h.cellGrapheme(0, 1)).toBe('b');
  });

  it('splits UTF-8 across feed() calls — wide grapheme reassembled', () => {
    const h = new Harness(3, 8);
    const bytes = new TextEncoder().encode('한');
    h.feed(bytes.slice(0, 2));
    h.feed(bytes.slice(2));
    expect(h.cellGrapheme(0, 0)).toBe('한');
    expect(h.emulator._getCell(0, 1)!.width).toBe(0);
  });
});

describe('VtEmulator — width (CJK / emoji)', () => {
  it('한글 wide grapheme occupies 2 cells', () => {
    const h = new Harness(3, 8);
    h.feed('한');
    expect(h.cellGrapheme(0, 0)).toBe('한');
    expect(h.emulator._getCell(0, 0)!.width).toBe(2);
    expect(h.emulator._getCell(0, 1)!.width).toBe(0);
    expect(h.emulator._getCursor().col).toBe(2);
  });

  it('emoji "👍" occupies 2 cells', () => {
    const h = new Harness(3, 8);
    h.feed('👍');
    expect(h.emulator._getCell(0, 0)!.width).toBe(2);
    expect(h.emulator._getCell(0, 1)!.width).toBe(0);
  });

  it('wide grapheme at end of row wraps to next row', () => {
    const h = new Harness(3, 4);
    h.feed('abc한');
    // "abc" fills cols 0..2; 한 (width 2) does not fit at col 3 → wrap.
    expect(h.rowText(0).trim()).toBe('abc');
    expect(h.cellGrapheme(1, 0)).toBe('한');
  });
});

describe('VtEmulator — CSI cursor movement', () => {
  it('CSI 5;10H moves cursor to row=4, col=9 (0-indexed)', () => {
    const h = new Harness(10, 12);
    h.feed('\x1b[5;10H');
    expect(h.emulator._getCursor().row).toBe(4);
    expect(h.emulator._getCursor().col).toBe(9);
  });

  it('CSI H (no params) moves cursor to origin (0,0)', () => {
    const h = new Harness(6, 6);
    h.feed('abc\x1b[H');
    expect(h.emulator._getCursor().row).toBe(0);
    expect(h.emulator._getCursor().col).toBe(0);
  });

  it('CSI 3A moves cursor up by 3', () => {
    const h = new Harness(6, 6);
    h.feed('\x1b[5;1H'); // row 4
    h.feed('\x1b[3A');
    expect(h.emulator._getCursor().row).toBe(1);
  });

  it('CSI B (no params) defaults to down 1', () => {
    const h = new Harness(6, 6);
    h.feed('\x1b[B');
    expect(h.emulator._getCursor().row).toBe(1);
  });

  it('CSI 2C moves cursor forward 2 cols', () => {
    const h = new Harness(4, 10);
    h.feed('\x1b[2C');
    expect(h.emulator._getCursor().col).toBe(2);
  });

  it('CSI 1D moves cursor backward 1 col', () => {
    const h = new Harness(4, 10);
    h.feed('abc\x1b[1D');
    expect(h.emulator._getCursor().col).toBe(2);
  });

  it('CSI G defaults to col=0', () => {
    const h = new Harness(4, 10);
    h.feed('abc\x1b[G');
    expect(h.emulator._getCursor().col).toBe(0);
  });

  it('CSI 7G moves cursor to col 6 (0-indexed)', () => {
    const h = new Harness(4, 10);
    h.feed('\x1b[7G');
    expect(h.emulator._getCursor().col).toBe(6);
  });

  it('CSI d moves row absolutely', () => {
    const h = new Harness(6, 6);
    h.feed('\x1b[4d');
    expect(h.emulator._getCursor().row).toBe(3);
  });

  it('clamps cursor at boundaries', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[100;100H');
    expect(h.emulator._getCursor().row).toBe(2);
    expect(h.emulator._getCursor().col).toBe(4);
  });

  it('CSI E moves down N lines to col 0', () => {
    const h = new Harness(6, 6);
    h.feed('abc\x1b[2E');
    expect(h.emulator._getCursor().row).toBe(2);
    expect(h.emulator._getCursor().col).toBe(0);
  });

  it('CSI F moves up N lines to col 0', () => {
    const h = new Harness(6, 6);
    h.feed('\x1b[3;3H\x1b[1F');
    expect(h.emulator._getCursor().row).toBe(1);
    expect(h.emulator._getCursor().col).toBe(0);
  });
});

describe('VtEmulator — erase ops', () => {
  it('CSI 2J erases the entire screen', () => {
    const h = new Harness(3, 5);
    h.feed('hi\nbye');
    h.feed('\x1b[2J');
    expect(h.rowText(0).trim()).toBe('');
    expect(h.rowText(1).trim()).toBe('');
  });

  it('CSI 0K (default) erases from cursor to end of line', () => {
    const h = new Harness(3, 8);
    h.feed('abcdef');
    h.feed('\x1b[3G\x1b[K'); // cursor to col 2, then EL 0
    expect(h.rowText(0).startsWith('ab')).toBe(true);
    expect(h.cellGrapheme(0, 2)).toBe('');
    expect(h.cellGrapheme(0, 3)).toBe('');
  });

  it('CSI 1K erases from start of line to cursor inclusive', () => {
    const h = new Harness(3, 8);
    h.feed('abcdef');
    h.feed('\x1b[4G\x1b[1K'); // cursor col 3 (d)
    expect(h.cellGrapheme(0, 0)).toBe('');
    expect(h.cellGrapheme(0, 1)).toBe('');
    expect(h.cellGrapheme(0, 2)).toBe('');
    expect(h.cellGrapheme(0, 3)).toBe('');
    expect(h.cellGrapheme(0, 4)).toBe('e');
  });

  it('CSI 2K erases entire line', () => {
    const h = new Harness(3, 8);
    h.feed('abcdef');
    h.feed('\x1b[2K');
    expect(h.rowText(0).trim()).toBe('');
  });

  it('CSI 0J erases cursor→end, later rows also cleared', () => {
    const h = new Harness(3, 5);
    h.feed('abc\r\nde\r\n12');
    h.feed('\x1b[2;2H\x1b[0J'); // cursor at row 1 col 1
    expect(h.rowText(1)).toBe('d    ');
    expect(h.rowText(2).trim()).toBe('');
  });

  it('CSI 1J erases start→cursor inclusive', () => {
    const h = new Harness(3, 5);
    h.feed('abc\r\nde\r\nfgh');
    h.feed('\x1b[2;2H\x1b[1J'); // row 1, col 1
    expect(h.rowText(0).trim()).toBe('');
    expect(h.rowText(1).trim()).toBe(''); // both chars before cursor incl.
    expect(h.rowText(2).trim()).toBe('fgh');
  });

  it('writes after ED start clean', () => {
    const h = new Harness(3, 5);
    h.feed('abc\nde');
    h.feed('\x1b[2J\x1b[H');
    h.feed('X');
    expect(h.cellGrapheme(0, 0)).toBe('X');
  });
});

describe('VtEmulator — insert / delete chars', () => {
  it('CSI @ 3 inserts 3 blanks at cursor', () => {
    const h = new Harness(3, 8);
    h.feed('abcdef');
    h.feed('\x1b[3G\x1b[3@'); // cursor col 2
    expect(h.cellGrapheme(0, 2)).toBe('');
    expect(h.cellGrapheme(0, 3)).toBe('');
    expect(h.cellGrapheme(0, 4)).toBe('');
    expect(h.cellGrapheme(0, 5)).toBe('c');
  });

  it('CSI P 2 deletes 2 chars, right-shifts', () => {
    const h = new Harness(3, 8);
    h.feed('abcdef');
    h.feed('\x1b[2G\x1b[2P'); // cursor col 1
    expect(h.cellGrapheme(0, 0)).toBe('a');
    expect(h.cellGrapheme(0, 1)).toBe('d');
    expect(h.cellGrapheme(0, 2)).toBe('e');
    expect(h.cellGrapheme(0, 3)).toBe('f');
  });

  it('CSI X 2 clears 2 chars without shifting', () => {
    const h = new Harness(3, 8);
    h.feed('abcdef');
    h.feed('\x1b[2G\x1b[2X'); // cursor col 1
    expect(h.cellGrapheme(0, 0)).toBe('a');
    expect(h.cellGrapheme(0, 1)).toBe('');
    expect(h.cellGrapheme(0, 2)).toBe('');
    expect(h.cellGrapheme(0, 3)).toBe('d');
  });
});

describe('VtEmulator — insert / delete lines', () => {
  it('CSI L 1 inserts a blank line at cursor, shifting rows down', () => {
    const h = new Harness(4, 5);
    h.feed('AAA\r\nBBB\r\nCCC');
    h.feed('\x1b[2;1H\x1b[L'); // insert at row 1
    expect(h.rowText(0).trim()).toBe('AAA');
    expect(h.rowText(1).trim()).toBe(''); // inserted blank
    expect(h.rowText(2).trim()).toBe('BBB');
    expect(h.rowText(3).trim()).toBe('CCC');
  });

  it('CSI M 1 deletes the row at cursor, shifting rows up', () => {
    const h = new Harness(4, 5);
    h.feed('AAA\r\nBBB\r\nCCC');
    h.feed('\x1b[2;1H\x1b[M'); // delete row 1
    expect(h.rowText(0).trim()).toBe('AAA');
    expect(h.rowText(1).trim()).toBe('CCC');
    expect(h.rowText(2).trim()).toBe('');
  });
});

describe('VtEmulator — scroll region + scroll ops', () => {
  it('CSI 2;4r sets scroll region to rows 1..3 (0-indexed)', () => {
    const h = new Harness(6, 5);
    h.feed('\x1b[2;4r');
    expect(h.emulator._getScrollRegion()).toEqual({ top: 1, bottom: 3 });
    // DECSTBM homes the cursor.
    expect(h.emulator._getCursor()).toMatchObject({ row: 0, col: 0 });
  });

  it('LF at region bottom scrolls region up', () => {
    const h = new Harness(6, 5);
    h.feed('\x1b[2;4r'); // scroll region rows 1..3
    h.feed('\x1b[2;1HA\nB\nC'); // fill rows 1..3
    h.feed('\x1b[4;4H\n'); // LF at row 3 (region bottom)
    // After scroll up: row 1 = "B", row 2 = "C", row 3 = blank
    expect(h.rowText(1).trim()).toBe('B');
    expect(h.rowText(2).trim()).toBe('C');
    expect(h.rowText(3).trim()).toBe('');
  });

  it('CSI 2S scrolls up 2 lines within the region', () => {
    const h = new Harness(5, 5);
    h.feed('A\nB\nC\nD');
    h.feed('\x1b[2S');
    expect(h.rowText(0).trim()).toBe('C');
    expect(h.rowText(1).trim()).toBe('D');
  });

  it('CSI 1T scrolls down 1 line within the region', () => {
    const h = new Harness(4, 5);
    h.feed('A\nB\nC');
    h.feed('\x1b[1T');
    expect(h.rowText(0).trim()).toBe('');
    expect(h.rowText(1).trim()).toBe('A');
    expect(h.rowText(2).trim()).toBe('B');
  });

  it('invalid DECSTBM resets to full screen', () => {
    const h = new Harness(5, 5);
    h.feed('\x1b[5;2r'); // top >= bottom → invalid
    expect(h.emulator._getScrollRegion()).toEqual({ top: 0, bottom: 4 });
  });

  it('LF outside region boundary moves cursor normally', () => {
    const h = new Harness(6, 5);
    h.feed('\x1b[2;4r');
    h.feed('X\n'); // outside region; cursor was row 0
    expect(h.emulator._getCursor().row).toBe(1);
  });
});

describe('VtEmulator — SGR', () => {
  it('CSI 31m applies red fg to subsequent cells', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[31mX');
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.fg).toMatchObject({ kind: 'named', index: 1 });
  });

  it('CSI 1;31m applies bold + red', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[1;31mX');
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.bold).toBe(true);
    expect(cell.fg).toMatchObject({ kind: 'named', index: 1 });
  });

  it('CSI 0m resets attrs back to default', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[1;31mX\x1b[0mY');
    const x = h.emulator._getCell(0, 0)!;
    const y = h.emulator._getCell(0, 1)!;
    expect(x.bold).toBe(true);
    expect(y.bold).toBe(false);
    expect(y.fg).toBe('default');
  });

  it('CSI m (empty) is equivalent to CSI 0m', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[31mX\x1b[mY');
    const y = h.emulator._getCell(0, 1)!;
    expect(y.fg).toBe('default');
  });

  it('CSI 38;5;214m sets indexed fg', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[38;5;214mX');
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.fg).toEqual({ kind: 'indexed', index: 214 });
  });

  it('CSI 38;2;100;200;50m sets RGB truecolor fg', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[38;2;100;200;50mX');
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.fg).toEqual({ kind: 'rgb', r: 100, g: 200, b: 50 });
  });

  it('CSI 90m sets bright fg (index 0)', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[90mX');
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.fg).toEqual({ kind: 'bright', index: 0 });
  });

  it('CSI 4m then 24m toggles underline', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[4mA\x1b[24mB');
    expect(h.emulator._getCell(0, 0)!.underline).toBe(true);
    expect(h.emulator._getCell(0, 1)!.underline).toBe(false);
  });

  it('CSI 7m inverse flag propagates', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[7mA');
    expect(h.emulator._getCell(0, 0)!.inverse).toBe(true);
  });
});

describe('VtEmulator — save / restore', () => {
  it('ESC 7 saves and ESC 8 restores cursor + sgr', () => {
    const h = new Harness(5, 5);
    h.feed('\x1b[3;3H');
    h.feed('\x1b[31m');
    h.feed('\x1b7'); // save
    h.feed('\x1b[1;1H\x1b[0m');
    h.feed('\x1b8'); // restore
    const cur = h.emulator._getCursor();
    expect(cur.row).toBe(2);
    expect(cur.col).toBe(2);
    h.feed('X');
    expect(h.emulator._getCell(2, 2)!.fg).toMatchObject({
      kind: 'named',
      index: 1,
    });
  });

  it('CSI s / u also save+restore cursor (xterm compat)', () => {
    const h = new Harness(5, 5);
    h.feed('\x1b[3;3H\x1b[s');
    h.feed('\x1b[1;1H\x1b[u');
    expect(h.emulator._getCursor()).toMatchObject({ row: 2, col: 2 });
  });
});

describe('VtEmulator — DEC private modes', () => {
  it('CSI ?25l hides cursor', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[?25l');
    expect(h.emulator._getCursor().visible).toBe(false);
  });

  it('CSI ?25h shows cursor after hiding', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[?25l\x1b[?25h');
    expect(h.emulator._getCursor().visible).toBe(true);
  });

  it('cursor-only DEC mode emits cursor_moved when visibility changes', () => {
    const h = new Harness(3, 5);
    h.clearEnvs();
    h.feed('\x1b[?25l');
    const cursorEvent = h.lastEnvOfKind('cursor_moved');
    expect(cursorEvent).toBeDefined();
    expect((cursorEvent!.payload as CursorMovedPayload).cursor.visible).toBe(false);
  });

  it('CSI ?7l disables DECAWM — typing past cols overwrites last col', () => {
    const h = new Harness(3, 4);
    h.feed('\x1b[?7l');
    h.feed('abcdef');
    expect(h.cellGrapheme(0, 0)).toBe('a');
    expect(h.cellGrapheme(0, 1)).toBe('b');
    expect(h.cellGrapheme(0, 2)).toBe('c');
    expect(h.cellGrapheme(0, 3)).toBe('f');
    // Still on row 0 since no wrap.
    expect(h.emulator._getCursor().row).toBe(0);
  });

  it('CSI ?1049h switches to a blank alt buffer; exit restores main', () => {
    // Post plan-0005 α2 the emulator itself owns the alt-buffer swap.
    // Entering 1049 must leave the previous main content invisible (alt
    // is blank) and DECRESET must byte-exactly restore main so vim/htop
    // exits stop smearing their paint onto the shell prompt.
    const h = new Harness(3, 5);
    h.feed('abc');
    h.feed('\x1b[?1049h');
    // On alt: first row should be entirely blank.
    expect(h.cellGrapheme(0, 0)).toBe('');
    expect(h.cellGrapheme(0, 1)).toBe('');
    expect(h.cellGrapheme(0, 2)).toBe('');
    h.feed('\x1b[?1049l');
    // Back on main: original content preserved byte-exact.
    expect(h.cellGrapheme(0, 0)).toBe('a');
    expect(h.cellGrapheme(0, 1)).toBe('b');
    expect(h.cellGrapheme(0, 2)).toBe('c');
  });
});

describe('VtEmulator — envelope emission', () => {
  it('each feed produces at most one grid_delta envelope', () => {
    const h = new Harness(4, 6);
    h.clearEnvs();
    h.feed('abc');
    const deltas = h.envs.filter((e) => e.payload.kind === 'grid_delta');
    expect(deltas.length).toBeLessThanOrEqual(1);
    expect(deltas.length).toBeGreaterThanOrEqual(1);
  });

  it('sequence numbers are strictly ascending', () => {
    const h = new Harness(4, 6);
    h.feed('abc');
    h.feed('\x1b[2;1Hdef');
    const seqs = h.envs.map((e) => e.sequence_no);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('cursor-only movement emits cursor_moved', () => {
    const h = new Harness(4, 6);
    h.feed('abc'); // moves cursor as side effect of delta
    h.clearEnvs();
    h.feed('\x1b[1;1H'); // pure cursor move, no cell change
    const cursorEvent = h.lastEnvOfKind('cursor_moved');
    expect(cursorEvent).toBeDefined();
    expect((cursorEvent!.payload as CursorMovedPayload).cursor.row).toBe(0);
    expect((cursorEvent!.payload as CursorMovedPayload).cursor.col).toBe(0);
  });

  it('delta envelope carries only dirty rows', () => {
    const h = new Harness(4, 6);
    h.feed('a\nb\nc');
    h.clearEnvs();
    h.feed('\x1b[2;1HX'); // touch only row 1
    const delta = h.lastEnvOfKind('grid_delta');
    expect(delta!.payload.row_deltas.map((d) => d.row)).toEqual([1]);
  });

  it('row revision_after is revision_before + 1', () => {
    const h = new Harness(3, 5);
    h.clearEnvs();
    h.feed('X');
    const delta = h.lastEnvOfKind('grid_delta');
    const rd = delta!.payload.row_deltas[0]!;
    expect(rd.revision_after).toBe(rd.revision_before + 1);
  });

  it('two feeds to same row produce monotonic revisions', () => {
    const h = new Harness(3, 5);
    h.clearEnvs();
    h.feed('X');
    h.feed('\rY');
    const deltas = h.envs.filter((e) => e.payload.kind === 'grid_delta') as Array<
      Env & { payload: GridDeltaPayload }
    >;
    expect(deltas.length).toBe(2);
    const first = deltas[0]!.payload.row_deltas[0]!;
    const second = deltas[1]!.payload.row_deltas[0]!;
    expect(second.revision_before).toBe(first.revision_after);
  });
});

describe('VtEmulator — resize', () => {
  it('resize emits a new grid_snapshot with matching dims', () => {
    const h = new Harness(4, 6);
    h.clearEnvs();
    h.emulator.resize(6, 10);
    const snap = h.lastEnvOfKind('grid_snapshot');
    expect(snap).toBeDefined();
    expect((snap!.payload as GridSnapshotPayload).rows).toBe(6);
    expect((snap!.payload as GridSnapshotPayload).cols).toBe(10);
  });

  it('preserves content in the top-left overlap', () => {
    const h = new Harness(4, 6);
    h.feed('hello');
    h.emulator.resize(4, 10);
    expect(h.cellGrapheme(0, 0)).toBe('h');
    expect(h.cellGrapheme(0, 4)).toBe('o');
  });

  it('resize_generation bumps per resize', () => {
    const h = new Harness(4, 6);
    const before = h.envs[0]!.resize_generation;
    h.emulator.resize(5, 7);
    const snap = h.lastEnvOfKind('grid_snapshot');
    expect(snap!.resize_generation).toBe(before + 1);
  });

  it('cursor clamps on shrink', () => {
    const h = new Harness(10, 10);
    h.feed('\x1b[8;8H');
    h.emulator.resize(4, 4);
    const cur = h.emulator._getCursor();
    expect(cur.row).toBeLessThan(4);
    expect(cur.col).toBeLessThan(4);
  });
});

describe('VtEmulator — malformed / partial', () => {
  it('invalid CSI (stray byte) does not corrupt state', () => {
    const h = new Harness(3, 5);
    // `\x1b[1;2Q` — Q is not a known final byte, so dispatch drops it.
    h.feed('\x1b[1;2Q');
    h.feed('X');
    expect(h.cellGrapheme(0, 0)).toBe('X');
  });

  it('CSI with garbage byte aborts and returns to Ground', () => {
    const h = new Harness(3, 5);
    // NUL (0x00) isn't a CSI param byte, so the FSM aborts and drops back to
    // Ground. The subsequent `H` is then printed as plain text.
    h.feed('\x1b[1;2\x00HX');
    expect(h.cellGrapheme(0, 0)).toBe('H');
    expect(h.cellGrapheme(0, 1)).toBe('X');
  });

  it('DCS payload is swallowed until ST', () => {
    const h = new Harness(3, 5);
    h.feed('\x1bPsome_dcs_payload\x1b\\');
    h.feed('Y');
    expect(h.cellGrapheme(0, 0)).toBe('Y');
  });

  it('OSC payload is swallowed (BEL terminator)', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b]0;my title\x07');
    h.feed('Z');
    expect(h.cellGrapheme(0, 0)).toBe('Z');
  });

  it('OSC payload is swallowed (ESC \\ terminator)', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b]8;;http://example\x1b\\link');
    // After ST, "link" is plain text.
    expect(h.cellGrapheme(0, 0)).toBe('l');
    expect(h.cellGrapheme(0, 3)).toBe('k');
  });

  it('APC payload is swallowed', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b_apc_blob\x1b\\');
    h.feed('W');
    expect(h.cellGrapheme(0, 0)).toBe('W');
  });

  it('charset designator consumes one byte arg', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b(BHi');
    // The designator `( B` is swallowed; "Hi" is the remaining text.
    expect(h.cellGrapheme(0, 0)).toBe('H');
    expect(h.cellGrapheme(0, 1)).toBe('i');
  });
});

describe('VtEmulator — snapshot() + reset()', () => {
  it('snapshot() emits a fresh grid_snapshot', () => {
    const h = new Harness(3, 5);
    h.feed('abc');
    h.clearEnvs();
    h.emulator.snapshot();
    const snap = h.lastEnvOfKind('grid_snapshot');
    expect(snap).toBeDefined();
  });

  it('reset() clears the grid and emits snapshot', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[31mhello');
    h.clearEnvs();
    h.emulator.reset();
    const snap = h.lastEnvOfKind('grid_snapshot');
    expect(snap).toBeDefined();
    expect(h.rowText(0).trim()).toBe('');
    expect(h.emulator._getCell(0, 0)!.fg).toBe('default');
  });
});

describe('VtEmulator — envelope shape vs GridMirror contract', () => {
  it('snapshot cols matches the number of row_deltas spans total', () => {
    const h = new Harness(2, 4);
    const snap = h.lastEnvOfKind('grid_snapshot')!;
    for (const rd of (snap.payload as GridSnapshotPayload).row_deltas) {
      let cols = 0;
      for (const span of rd.spans) cols += span.cols;
      expect(cols).toBe(4);
    }
  });

  it('delta row span widths cover the full row', () => {
    const h = new Harness(3, 6);
    h.clearEnvs();
    h.feed('ab');
    const delta = h.lastEnvOfKind('grid_delta')!;
    const rd = delta.payload.row_deltas[0]!;
    let cols = 0;
    for (const span of rd.spans) cols += span.cols;
    expect(cols).toBe(6);
  });

  it('snapshot carries cursor state', () => {
    const h = new Harness(3, 5);
    h.feed('abc');
    h.clearEnvs();
    h.emulator.snapshot();
    const snap = h.lastEnvOfKind('grid_snapshot')!;
    const payload = snap.payload as GridSnapshotPayload;
    expect(payload.cursor).toBeDefined();
    expect(payload.cursor!.col).toBe(3);
  });

  it('wide grapheme span carries cols=2', () => {
    const h = new Harness(2, 4);
    h.clearEnvs();
    h.feed('한');
    const delta = h.lastEnvOfKind('grid_delta')!;
    const rd = delta.payload.row_deltas[0]!;
    // First span should be the wide grapheme.
    const wide = rd.spans.find((s) => s.cols === 2);
    expect(wide).toBeDefined();
  });
});

describe('VtEmulator — styled output encoding', () => {
  it('sgr hex is 16-char 0x-prefixed', () => {
    const h = new Harness(2, 3);
    h.clearEnvs();
    h.feed('\x1b[31mX');
    const delta = h.lastEnvOfKind('grid_delta')!;
    const rd = delta.payload.row_deltas[0]!;
    const styled = rd.spans.find((s) => s.sgr !== '0x0000000000000000');
    expect(styled).toBeDefined();
    expect(styled!.sgr).toMatch(/^0x[0-9A-F]{16}$/);
  });

  it('blank cells emit "blank" graphemes', () => {
    const h = new Harness(2, 4);
    const snap = h.lastEnvOfKind('grid_snapshot')!;
    const rd = (snap.payload as GridSnapshotPayload).row_deltas[0]!;
    expect(rd.spans[0]!.graphemes).toBe('blank');
  });
});

describe('VtEmulator — DECSC/DECRC spec compliance', () => {
  it('DECSC/DECRC does NOT save or restore scroll region (xterm spec)', () => {
    const h = new Harness(6, 5);
    // Set a non-default scroll region and save state.
    h.feed('\x1b[2;4r'); // scroll region rows 1..3
    h.feed('\x1b7'); // DECSC
    expect(h.emulator._getScrollRegion()).toEqual({ top: 1, bottom: 3 });
    // Mutate scroll region after save.
    h.feed('\x1b[1;5r'); // new region rows 0..4
    expect(h.emulator._getScrollRegion()).toEqual({ top: 0, bottom: 4 });
    // Restore — scroll region should NOT revert; it stays at the post-save value.
    h.feed('\x1b8'); // DECRC
    expect(h.emulator._getScrollRegion()).toEqual({ top: 0, bottom: 4 });
  });

  it('DECSC/DECRC saves and restores DECAWM (autoWrap)', () => {
    const h = new Harness(3, 5);
    // Default autoWrap is on. Save state while on.
    h.feed('\x1b7'); // DECSC (autoWrap=true saved)
    // Disable autoWrap via DECRST 7.
    h.feed('\x1b[?7l');
    // Write past the right margin — with autoWrap off, the cursor should
    // clamp to the last column instead of wrapping.
    h.feed('ABCDEF'); // 6 chars into 5-col grid
    expect(h.emulator._getCursor().row).toBe(0);
    // Restore — autoWrap should come back on.
    h.feed('\x1b8'); // DECRC
    // Home the cursor, then write past margin. Wrap should now happen.
    h.feed('\x1b[H');
    h.feed('ABCDEF'); // 6 chars into 5-col grid; F wraps to row 1.
    expect(h.cellGrapheme(1, 0)).toBe('F');
  });

  it('DECSC/DECRC restores cursor + SGR but leaves scroll region intact', () => {
    const h = new Harness(6, 5);
    h.feed('\x1b[3;4H'); // cursor to (2,3)
    h.feed('\x1b[31m'); // red fg
    h.feed('\x1b7'); // DECSC
    h.feed('\x1b[1;1H'); // move elsewhere
    h.feed('\x1b[32m'); // green fg
    h.feed('\x1b[2;4r'); // mutate scroll region AFTER save
    h.feed('\x1b8'); // DECRC
    expect(h.emulator._getCursor()).toMatchObject({ row: 2, col: 3 });
    // Scroll region from the mutation persists (not restored).
    expect(h.emulator._getScrollRegion()).toEqual({ top: 1, bottom: 3 });
    // SGR restored — write one cell and check fg.
    h.feed('X');
    expect(h.emulator._getCell(2, 3)!.fg).toMatchObject({ kind: 'named', index: 1 });
  });
});

describe('VtEmulator — charset designator robustness (A11)', () => {
  it('ESC ( B LF X — next printable after LF is not dropped', () => {
    const h = new Harness(3, 5);
    // ESC ( B consumes 'B' as charset designator. Then LF is the next
    // byte — previously the flag stayed set and 'X' was dropped. Now
    // LF is consumed as the designator byte itself (no-op charset), and
    // 'X' reaches the grid normally on row 0 col 0 (no LF executed).
    h.feed('\x1b(B\nX');
    // X must land somewhere — not be swallowed.
    let found = false;
    for (let r = 0; r < 3 && !found; r += 1) {
      for (let c = 0; c < 5 && !found; c += 1) {
        if (h.cellGrapheme(r, c) === 'X') found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('ESC ( B TAB X — next printable after TAB is not dropped', () => {
    const h = new Harness(3, 16);
    h.feed('\x1b(B\tX');
    // X must land somewhere — not be swallowed.
    let found = false;
    for (let c = 0; c < 16 && !found; c += 1) {
      if (h.cellGrapheme(0, c) === 'X') found = true;
    }
    expect(found).toBe(true);
  });
});

describe('VtEmulator — erase across wide-char boundary (A24)', () => {
  it('erase starting mid wide-char also blanks the leader', () => {
    const h = new Harness(2, 6);
    // Write a wide char at (0,0-1), then narrow 'X' at (0,2).
    h.feed('한X');
    // Cursor now at col 3. Move cursor to col 1 (the trailer of '한').
    h.feed('\x1b[1;2H'); // row 1, col 2 (1-indexed) → (0,1)
    // Erase from cursor to end of line. Range starts at a trailer — fix
    // must expand left to include the leader at col 0.
    h.feed('\x1b[0K');
    expect(h.emulator._getCell(0, 0)!.grapheme).toBe('');
    expect(h.emulator._getCell(0, 0)!.width).toBe(1);
    expect(h.emulator._getCell(0, 1)!.grapheme).toBe('');
    expect(h.emulator._getCell(0, 1)!.width).toBe(1);
  });

  it('erase ending mid wide-char also blanks the trailer', () => {
    const h = new Harness(2, 6);
    // Layout: col0='X' col1='한'(leader) col2=(trailer) col3='Y' ...
    h.feed('X한Y');
    // Move cursor home and EL mode 1 (start → cursor inclusive) with
    // cursor at col 1 — range endCol is the leader of the wide char.
    // The fix must extend right to include the trailer at col 2.
    h.feed('\x1b[1;2H'); // row 1, col 2 → (0,1)
    h.feed('\x1b[1K'); // erase from start to cursor inclusive
    expect(h.emulator._getCell(0, 0)!.grapheme).toBe('');
    expect(h.emulator._getCell(0, 1)!.grapheme).toBe('');
    expect(h.emulator._getCell(0, 1)!.width).toBe(1);
    expect(h.emulator._getCell(0, 2)!.grapheme).toBe('');
    expect(h.emulator._getCell(0, 2)!.width).toBe(1);
    // 'Y' beyond should remain.
    expect(h.emulator._getCell(0, 3)!.grapheme).toBe('Y');
  });
});

describe('VtEmulator — DECSTBM with zero params (A1)', () => {
  it('CSI 0;24 r on 24-row terminal sets full-screen region (0..23)', () => {
    const h = new Harness(24, 80);
    // `0;24` — top=0 should mean "default" (=1), bottom=24.
    h.feed('\x1b[0;24r');
    expect(h.emulator._getScrollRegion()).toEqual({ top: 0, bottom: 23 });
  });

  it('CSI 0;0 r treats both zeros as defaults (full region)', () => {
    const h = new Harness(10, 5);
    h.feed('\x1b[0;0r');
    expect(h.emulator._getScrollRegion()).toEqual({ top: 0, bottom: 9 });
  });

  it('CSI r (no params) sets full-screen region', () => {
    const h = new Harness(8, 5);
    // First set a non-default region, then reset.
    h.feed('\x1b[2;5r');
    expect(h.emulator._getScrollRegion()).toEqual({ top: 1, bottom: 4 });
    h.feed('\x1b[r');
    expect(h.emulator._getScrollRegion()).toEqual({ top: 0, bottom: 7 });
  });
});

describe('VtEmulator — DECSTBM degenerate 1-row scroll region (bug 3)', () => {
  it('CSI 5;5r on a 10-row terminal sets a 1-row region at row 4 (0-indexed)', () => {
    const h = new Harness(10, 5);
    h.feed('\x1b[5;5r');
    expect(h.emulator._getScrollRegion()).toEqual({ top: 4, bottom: 4 });
    // DECSTBM homes the cursor.
    expect(h.emulator._getCursor()).toMatchObject({ row: 0, col: 0 });
  });

  it('newline inside a 1-row scroll region is a no-op (no infinite loop)', () => {
    const h = new Harness(10, 5);
    h.feed('\x1b[5;5r'); // 1-row region at row 4
    h.feed('\x1b[5;1H'); // move cursor into the region
    // Feed a linefeed — the region is 1 row so scrollUpRegion should produce
    // a no-op (scrolls top..top, count=1, no rows shift, blank replaces same
    // row). Most importantly this must not hang or loop.
    h.feed('\n');
    // Cursor stays in the region (row 4, scrolled but same position).
    expect(h.emulator._getCursor().row).toBe(4);
  });

  it('resetting with CSI r restores the full-screen region after a 1-row region', () => {
    const h = new Harness(10, 5);
    h.feed('\x1b[5;5r'); // 1-row region
    expect(h.emulator._getScrollRegion()).toEqual({ top: 4, bottom: 4 });
    h.feed('\x1b[r'); // reset to full screen
    expect(h.emulator._getScrollRegion()).toEqual({ top: 0, bottom: 9 });
  });
});

describe('VtEmulator — OSC 7 working-directory report', () => {
  it('parses file:///path payload and invokes onCwdChanged', () => {
    const seen: string[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onCwdChanged: (cwd) => seen.push(cwd),
    });
    emulator.feed(new TextEncoder().encode('\x1b]7;file:///Users/songmin/project\x07'));
    expect(seen).toEqual(['/Users/songmin/project']);
  });

  it('tolerates ESC \\ terminator and a host segment', () => {
    const seen: string[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onCwdChanged: (cwd) => seen.push(cwd),
    });
    emulator.feed(
      new TextEncoder().encode('\x1b]7;file://myhost/tmp/work%20dir\x1b\\'),
    );
    expect(seen).toEqual(['/tmp/work dir']);
  });

  it('drops payloads missing the file:// scheme', () => {
    const seen: string[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onCwdChanged: (cwd) => seen.push(cwd),
    });
    emulator.feed(new TextEncoder().encode('\x1b]7;/raw/path\x07'));
    expect(seen).toEqual([]);
  });
});

describe('VtEmulator — OSC 10/11 fg/bg color query', () => {
  it('responds to OSC 10 ? with the current theme fg in rgb:RR/GG/BB', () => {
    const replies: Uint8Array[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onRespond: (b) => replies.push(b),
      themeColors: () => ({ fg: { r: 0xe6, g: 0xe8, b: 0xee }, bg: { r: 0x0b, g: 0x0c, b: 0x10 } }),
    });
    emulator.feed(new TextEncoder().encode('\x1b]10;?\x07'));
    expect(replies).toHaveLength(1);
    const text = new TextDecoder().decode(replies[0]!);
    expect(text).toBe('\x1b]10;rgb:e6/e8/ee\x07');
  });

  it('responds to OSC 11 ? with the current theme bg', () => {
    const replies: Uint8Array[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onRespond: (b) => replies.push(b),
      themeColors: () => ({ fg: { r: 0xff, g: 0xff, b: 0xff }, bg: { r: 0x12, g: 0x34, b: 0x56 } }),
    });
    emulator.feed(new TextEncoder().encode('\x1b]11;?\x07'));
    expect(replies).toHaveLength(1);
    const text = new TextDecoder().decode(replies[0]!);
    expect(text).toBe('\x1b]11;rgb:12/34/56\x07');
  });

  it('silently drops OSC 10/11 SET attempts (only ? is answered)', () => {
    const replies: Uint8Array[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onRespond: (b) => replies.push(b),
      themeColors: () => ({ fg: { r: 0, g: 0, b: 0 }, bg: { r: 0, g: 0, b: 0 } }),
    });
    emulator.feed(new TextEncoder().encode('\x1b]10;rgb:ff/00/00\x07'));
    expect(replies).toHaveLength(0);
  });
});

describe('VtEmulator — DSR / DA query responses', () => {
  it('CSI 6n replies with the 1-indexed cursor position', () => {
    const replies: Uint8Array[] = [];
    const emulator = new VtEmulator({
      rows: 5,
      cols: 10,
      onEnvelope: () => {},
      onRespond: (b) => replies.push(b),
    });
    // Move to row 3, col 7 (1-indexed), then query.
    emulator.feed(new TextEncoder().encode('\x1b[3;7H\x1b[6n'));
    const last = replies[replies.length - 1];
    expect(last).toBeDefined();
    expect(new TextDecoder().decode(last!)).toBe('\x1b[3;7R');
  });

  it('CSI 5n replies with CSI 0n (ready)', () => {
    const replies: Uint8Array[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onRespond: (b) => replies.push(b),
    });
    emulator.feed(new TextEncoder().encode('\x1b[5n'));
    expect(replies).toHaveLength(1);
    expect(new TextDecoder().decode(replies[0]!)).toBe('\x1b[0n');
  });

  it('CSI c replies with primary DA ?1;2c', () => {
    const replies: Uint8Array[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onRespond: (b) => replies.push(b),
    });
    emulator.feed(new TextEncoder().encode('\x1b[c'));
    expect(replies).toHaveLength(1);
    expect(new TextDecoder().decode(replies[0]!)).toBe('\x1b[?1;2c');
  });

  it('CSI 0c also replies with primary DA', () => {
    const replies: Uint8Array[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onRespond: (b) => replies.push(b),
    });
    emulator.feed(new TextEncoder().encode('\x1b[0c'));
    expect(replies).toHaveLength(1);
    expect(new TextDecoder().decode(replies[0]!)).toBe('\x1b[?1;2c');
  });

  it('CSI >0c replies with secondary DA including the configured version', () => {
    const replies: Uint8Array[] = [];
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onRespond: (b) => replies.push(b),
      secondaryDaVersion: 42,
    });
    emulator.feed(new TextEncoder().encode('\x1b[>0c'));
    expect(replies).toHaveLength(1);
    expect(new TextDecoder().decode(replies[0]!)).toBe('\x1b[>0;42;0c');
  });

  it('queries are silently dropped when onRespond is unset', () => {
    // Constructs without onRespond — must not throw on any query kind.
    const emulator = new VtEmulator({ rows: 3, cols: 5, onEnvelope: () => {} });
    emulator.feed(new TextEncoder().encode('\x1b[6n\x1b[5n\x1b[c\x1b[>0c\x1b]10;?\x07'));
    // No assertion needed beyond "doesn't throw".
    expect(emulator.getDimensions()).toEqual({ rows: 3, cols: 5 });
  });
});

describe('VtEmulator — Kitty keyboard flag protocol (CSI u variants)', () => {
  function makeEmulator(opts: {
    onChange?: (flags: number) => void;
  } = {}) {
    const replies: Uint8Array[] = [];
    const base = {
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onRespond: (b: Uint8Array) => {
        replies.push(b);
      },
    } as const;
    const emulator = opts.onChange
      ? new VtEmulator({ ...base, onKittyKeyboardFlagsChanged: opts.onChange })
      : new VtEmulator(base);
    return {
      emulator,
      replies,
      lastReplyText: () =>
        replies.length === 0
          ? null
          : new TextDecoder().decode(replies[replies.length - 1]!),
    };
  }

  it('CSI ? u on a fresh emulator answers CSI ? 0 u (no flags active)', () => {
    const h = makeEmulator();
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.replies).toHaveLength(1);
    expect(h.lastReplyText()).toBe('\x1b[?0u');
  });

  it('CSI > 1 u pushes the disambiguate-escape-codes flag and notifies the host', () => {
    const changes: number[] = [];
    const h = makeEmulator({ onChange: (f) => changes.push(f) });
    h.emulator.feed(new TextEncoder().encode('\x1b[>1u\x1b[?u'));
    expect(changes).toEqual([1]);
    expect(h.lastReplyText()).toBe('\x1b[?1u');
  });

  it('CSI = <flags> u ORs the bits into the current top', () => {
    const changes: number[] = [];
    const h = makeEmulator({ onChange: (f) => changes.push(f) });
    // Start by pushing flags=2.
    h.emulator.feed(new TextEncoder().encode('\x1b[>2u'));
    expect(changes).toEqual([2]);
    // `CSI = 1 u` with default mode (OR) → top becomes 3.
    h.emulator.feed(new TextEncoder().encode('\x1b[=1u'));
    expect(changes[changes.length - 1]).toBe(3);
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?3u');
  });

  it('CSI = <flags> ; 2 u replaces (mode=2) the current top exactly', () => {
    const h = makeEmulator();
    h.emulator.feed(new TextEncoder().encode('\x1b[>7u')); // push 7
    h.emulator.feed(new TextEncoder().encode('\x1b[=2;2u')); // replace with 2
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?2u');
  });

  it('CSI = <flags> ; 3 u clears (AND-NOT) bits from the current top', () => {
    const h = makeEmulator();
    h.emulator.feed(new TextEncoder().encode('\x1b[>7u')); // push 7 (0b00111)
    h.emulator.feed(new TextEncoder().encode('\x1b[=2;3u')); // clear bit 2 → 5
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?5u');
  });

  it('CSI < u pops the stack; query reflects the restored entry', () => {
    const h = makeEmulator();
    h.emulator.feed(new TextEncoder().encode('\x1b[>1u\x1b[>2u'));
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?2u');
    h.emulator.feed(new TextEncoder().encode('\x1b[<u'));
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?1u');
  });

  it('CSI < <n> u pops n entries in one go', () => {
    const h = makeEmulator();
    h.emulator.feed(new TextEncoder().encode('\x1b[>1u\x1b[>2u\x1b[>4u'));
    h.emulator.feed(new TextEncoder().encode('\x1b[<2u'));
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?1u');
  });

  it('popping the last remaining entry resets to 0 (never leaves the stack empty)', () => {
    const changes: number[] = [];
    const h = makeEmulator({ onChange: (f) => changes.push(f) });
    h.emulator.feed(new TextEncoder().encode('\x1b[>3u'));
    h.emulator.feed(new TextEncoder().encode('\x1b[<u'));
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?0u');
    expect(changes).toEqual([3, 0]);
  });

  it('stack overflow past 10 pushes drops the oldest entry', () => {
    const h = makeEmulator();
    // Stack seeded with [0]. Push 12 distinct values; max depth is 10,
    // so the final 10 should be retained. We confirm by popping until we
    // hit the oldest remaining value.
    const pushes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    for (const v of pushes) {
      h.emulator.feed(new TextEncoder().encode(`\x1b[>${v}u`));
    }
    // Top is still the last pushed flag (mask keeps low 5 bits → 12).
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?12u');
    // Pop 9 times — we should still have entries left (depth capped at 10).
    for (let i = 0; i < 9; i++) {
      h.emulator.feed(new TextEncoder().encode('\x1b[<u'));
    }
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    // After 12 pushes capped at 10 plus 9 pops, the value at the bottom
    // is the earliest surviving push (index 12 - 10 + 1 = 3 → value "3").
    expect(h.lastReplyText()).toBe('\x1b[?3u');
  });

  it('flag bits above the 5-bit spec mask are silently discarded', () => {
    const h = makeEmulator();
    // 0x40 = 64 — above the 0x1f mask.
    h.emulator.feed(new TextEncoder().encode('\x1b[>64u\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?0u');
  });

  it('CSI u (no private byte) still routes to DECRC, not the Kitty handler', () => {
    // We test this by observing that no reply is emitted and the cursor
    // is set to (0,0) by the default DECRC path.
    const h = makeEmulator();
    h.emulator.feed(new TextEncoder().encode('\x1b[5;5H\x1b[u'));
    expect(h.replies).toHaveLength(0); // DECRC never calls onRespond.
  });

  it('CSI ? u with no onRespond wired does not throw', () => {
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
    });
    emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(emulator.getDimensions()).toEqual({ rows: 3, cols: 5 });
  });

  it('reset() clears the kitty flag stack back to [0] and notifies the host', () => {
    const changes: number[] = [];
    const h = makeEmulator({ onChange: (f) => changes.push(f) });
    h.emulator.feed(new TextEncoder().encode('\x1b[>5u'));
    expect(changes).toEqual([5]);
    h.emulator.reset();
    expect(changes).toEqual([5, 0]);
    h.emulator.feed(new TextEncoder().encode('\x1b[?u'));
    expect(h.lastReplyText()).toBe('\x1b[?0u');
  });
});

describe('VtEmulator — BEL / onBell hook', () => {
  it('fires onBell for a bare BEL byte in Ground state', () => {
    let calls = 0;
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onBell: () => {
        calls += 1;
      },
    });
    emulator.feed(new TextEncoder().encode('hi\x07there'));
    expect(calls).toBe(1);
  });

  it('fires onBell once per bare BEL (multiple bells in one feed)', () => {
    let calls = 0;
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onBell: () => {
        calls += 1;
      },
    });
    emulator.feed(new TextEncoder().encode('\x07\x07\x07'));
    expect(calls).toBe(3);
  });

  it('does NOT fire onBell when BEL terminates an OSC string', () => {
    let calls = 0;
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onBell: () => {
        calls += 1;
      },
    });
    // OSC 0 set-title payload — xterm uses BEL as the legacy terminator.
    emulator.feed(new TextEncoder().encode('\x1b]0;window title\x07'));
    expect(calls).toBe(0);
  });

  it('does NOT fire onBell for BEL inside DCS / APC / PM bodies', () => {
    let calls = 0;
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onBell: () => {
        calls += 1;
      },
    });
    // DCS with a BEL terminator — we accept BEL as string terminator in
    // IgnoreUntilSt too (see stepIgnore).
    emulator.feed(new TextEncoder().encode('\x1bPpayload\x07'));
    // APC
    emulator.feed(new TextEncoder().encode('\x1b_payload\x07'));
    // PM
    emulator.feed(new TextEncoder().encode('\x1b^payload\x07'));
    expect(calls).toBe(0);
  });

  it('fires onBell for a bare BEL immediately after a completed OSC', () => {
    // Regression guard: after OSC dispatches, we return to Ground. A
    // subsequent bare BEL MUST count as a real bell.
    let calls = 0;
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onBell: () => {
        calls += 1;
      },
    });
    emulator.feed(new TextEncoder().encode('\x1b]0;title\x07\x07'));
    expect(calls).toBe(1);
  });

  it('swallows host-thrown exceptions from onBell', () => {
    const emulator = new VtEmulator({
      rows: 3,
      cols: 5,
      onEnvelope: () => {},
      onBell: () => {
        throw new Error('boom');
      },
    });
    // Must not propagate — parser state integrity is paramount.
    expect(() => {
      emulator.feed(new TextEncoder().encode('\x07'));
    }).not.toThrow();
  });
});
