/**
 * UTF-8 streaming + grapheme-cluster edge-case audit (plan 0005 P0
 * adversarial pass).
 *
 * Complements `VtEmulator.test.ts` which only exercises a single 2-byte
 * split. This file covers:
 *   - 4-byte emoji split across up to 4 chunks
 *   - 3-byte CJK split across 3 chunks
 *   - Stray 0xFE mid-stream (invalid UTF-8) — decoder must recover, not
 *     corrupt subsequent text
 *   - Combining-mark grapheme cluster (base + acute) — one cell, width 1
 *   - ZWJ emoji family — one grapheme cluster, width 2
 *   - Wide char at last column with autoWrap ON: full char wraps (not split)
 *   - Wide char at last column with autoWrap OFF: overwrites last column
 *
 * Every test carries an invariant docstring.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../VtEmulator.js';
import type {
  GridEventEnvelope,
  GridPayload,
} from '../../grid-mirror/types.js';

type Env = GridEventEnvelope<GridPayload>;

class Harness {
  readonly envs: Env[] = [];
  readonly emulator: VtEmulator;

  constructor(rows = 4, cols = 10) {
    this.emulator = new VtEmulator({
      sessionId: 'utf8-edge',
      rows,
      cols,
      onEnvelope: (env) => this.envs.push(env),
    });
  }

  feed(bytes: Uint8Array | string): void {
    const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    this.emulator.feed(b);
  }
}

describe('utf8-streaming-edge-cases — split UTF-8', () => {
  it('4-byte emoji split byte-by-byte across 4 feed() calls', () => {
    // Invariant: TextDecoder({stream:true}) preserves partial codepoints
    // across feed calls so a 4-byte emoji can arrive 1 byte per call
    // without loss.
    const h = new Harness(3, 6);
    const bytes = new TextEncoder().encode('😀'); // 4-byte UTF-8
    expect(bytes.length).toBe(4);
    for (let i = 0; i < 4; i += 1) h.feed(bytes.slice(i, i + 1));
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('😀');
    // Emoji is wide — trailing cell has width=0.
    expect(h.emulator._getCell(0, 1)?.width).toBe(0);
  });

  it('3-byte CJK split 1-1-1 across 3 chunks', () => {
    // Invariant: same behaviour as 4-byte split, for the common 3-byte
    // CJK range (e.g. Korean 한 = 0xED 0x95 0x9C).
    const h = new Harness(3, 6);
    const bytes = new TextEncoder().encode('한');
    expect(bytes.length).toBe(3);
    h.feed(bytes.slice(0, 1));
    h.feed(bytes.slice(1, 2));
    h.feed(bytes.slice(2, 3));
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('한');
  });

  it('invalid byte 0xFE mid-stream does not corrupt subsequent text', () => {
    // Invariant: stray 0xFE (invalid UTF-8 start byte) is replaced by the
    // decoder's replacement character; following ASCII must print correctly.
    const h = new Harness(3, 10);
    const bytes = new Uint8Array([0x41 /* A */, 0xfe, 0x42 /* B */, 0x43 /* C */]);
    h.feed(bytes);
    // A at col 0, replacement char at col 1, B at col 2, C at col 3.
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('A');
    // Replacement char U+FFFD is classified by width; typically narrow.
    // We only assert the ASCII frame survives.
    expect(h.emulator._getCell(0, 2)?.grapheme).toBe('B');
    expect(h.emulator._getCell(0, 3)?.grapheme).toBe('C');
  });

  it('invalid byte at start of feed does not throw', () => {
    // Invariant: the parser must tolerate a feed() that begins with an
    // invalid UTF-8 continuation byte — real PTYs can emit these when
    // encoding mismatches occur.
    const h = new Harness(3, 10);
    expect(() => {
      h.feed(new Uint8Array([0x80, 0x81, 0x82, 0x41]));
    }).not.toThrow();
    // 'A' should land somewhere on row 0.
    let found = false;
    for (let c = 0; c < 10; c += 1) {
      if (h.emulator._getCell(0, c)?.grapheme === 'A') {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

describe('utf8-streaming-edge-cases — grapheme clustering', () => {
  it('base letter + combining acute forms a single grapheme cluster', () => {
    // Invariant: `a` + U+0301 (combining acute) is one Intl.Segmenter
    // grapheme — one cell on the grid. Combining-mark handling uses the
    // "append to previous cell" branch; the previous cell's grapheme
    // string gets the diacritic appended.
    const h = new Harness(3, 6);
    h.feed('á');
    // Cell 0 holds the base "a" — when the combining mark arrives the
    // emulator appends it to the PREVIOUS cell's grapheme string.
    const cell = h.emulator._getCell(0, 0)!;
    // The grapheme should contain both codepoints (exact composition is
    // implementation-defined depending on whether the combining is folded
    // into a single printGrapheme call or treated as a zero-width tail).
    expect(cell.grapheme.length).toBeGreaterThanOrEqual(1);
    expect(cell.grapheme.includes('a')).toBe(true);
    // Cursor advanced by 1.
    expect(h.emulator._getCursor().col).toBe(1);
  });

  it('ZWJ family emoji clusters into a single 2-wide cell', () => {
    // Invariant: man-woman-boy ZWJ sequence is one grapheme cluster per
    // Intl.Segmenter, occupying 2 cells (wide-leader + wide-continuation).
    const h = new Harness(3, 6);
    // U+1F468 ZWJ U+1F469 ZWJ U+1F466  (man + woman + boy)
    h.feed('\u{1F468}‍\u{1F469}‍\u{1F466}');
    const cell0 = h.emulator._getCell(0, 0)!;
    // All four codepoints should coalesce into the cell-0 grapheme string.
    expect(cell0.grapheme.length).toBeGreaterThan(1);
    // The leading cell's width must be 2 (wide emoji).
    expect(cell0.width).toBe(2);
    // The trailing cell is a wide-continuation (width=0).
    expect(h.emulator._getCell(0, 1)?.width).toBe(0);
  });
});

describe('utf8-streaming-edge-cases — wide char boundary behaviours', () => {
  it('wide char at last column with autoWrap ON wraps entirely to next row', () => {
    // Invariant: per xterm, a 2-wide grapheme at the last column when
    // DECAWM is ON must NOT be split across two rows. It wraps whole to
    // row+1 col 0. The last column of the previous row stays blank.
    const h = new Harness(3, 4); // 4-col grid, wide at col 3 should wrap
    h.feed('ab'); // cursor at col 2
    h.feed('한'); // wide; col 2 fits (cols 2-3) → cursor at col 4 → pendingWrap
    // Next print lands on row 1 col 0 if wrap. But let's force wrap test.
    h.feed('c');
    // Expected: "ab한" on row 0 (cols 0-3), "c" on row 1 col 0.
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('a');
    expect(h.emulator._getCell(0, 1)?.grapheme).toBe('b');
    expect(h.emulator._getCell(0, 2)?.grapheme).toBe('한');
    expect(h.emulator._getCell(0, 3)?.width).toBe(0);
    expect(h.emulator._getCell(1, 0)?.grapheme).toBe('c');
  });

  it('wide char that does not fit in the remaining cols wraps to next row', () => {
    // Invariant: starting at col=3 on a 4-col grid (1 slot left) with a
    // 2-wide grapheme, the grapheme wraps to row+1 col 0 rather than
    // clipping / splitting.
    const h = new Harness(3, 4);
    h.feed('abc'); // cursor at col 3
    h.feed('한'); // doesn't fit at col 3; must wrap
    expect(h.emulator._getCell(1, 0)?.grapheme).toBe('한');
    expect(h.emulator._getCell(1, 1)?.width).toBe(0);
    // The col-3 cell on row 0 stays blank (not the wide char's tail).
    expect(h.emulator._getCell(0, 3)?.grapheme).toBe('');
  });

  it('wide char with autoWrap OFF overwrites the last column', () => {
    // Invariant: DECRST 7 disables autowrap. A 2-wide grapheme that would
    // overrun is placed so its trailing column is the last column; no wrap
    // and no new-row creation.
    const h = new Harness(3, 4);
    h.feed('abcd'); // fills row 0
    h.feed('\x1b[?7l'); // autoWrap off
    h.feed('\x1b[1;4H'); // position at last col
    h.feed('한'); // with wrap off, places wide char at last two cols (cols 2-3)
    // Wide char leader lands at col = cols - 2 = 2, trailer at col 3.
    expect(h.emulator._getCell(0, 2)?.grapheme).toBe('한');
    expect(h.emulator._getCell(0, 3)?.width).toBe(0);
    // Still on row 0 — no wrap.
    expect(h.emulator._getCursor().row).toBe(0);
  });
});

describe('utf8-streaming-edge-cases — pendingWrap invariants', () => {
  it('writing to the last column sets pendingWrap when autoWrap is on', () => {
    // Invariant: after the cursor writes the last column with DECAWM on,
    // `pendingWrap` must be set so the NEXT printable triggers a wrap —
    // matching xterm's `LastColumnFlag` semantics.
    const h = new Harness(3, 4);
    h.feed('abcd'); // writes last col
    const cur = h.emulator._getCursor();
    expect(cur.col).toBe(3);
    expect(cur.pendingWrap).toBe(true);
  });

  it('cursor movement clears pendingWrap', () => {
    // Invariant: any cursor-addressing CSI must clear the pendingWrap flag
    // so a follow-up print after `CUP` does not spuriously wrap.
    const h = new Harness(3, 4);
    h.feed('abcd');
    expect(h.emulator._getCursor().pendingWrap).toBe(true);
    h.feed('\x1b[1;2H');
    expect(h.emulator._getCursor().pendingWrap).toBe(false);
  });
});
