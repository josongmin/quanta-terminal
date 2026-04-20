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

  it('CSI ?1049h (alt screen flip) is a no-op here', () => {
    const h = new Harness(3, 5);
    h.feed('abc\x1b[?1049h');
    // Grid state preserved — alt-screen routing is out of scope.
    expect(h.cellGrapheme(0, 0)).toBe('a');
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
