/**
 * Grapheme cluster audit — combining marks, ZWJ sequences, flag emoji.
 *
 * The emulator uses a module-scoped `Intl.Segmenter` (granularity:
 * 'grapheme') to split decoded feed text into clusters, then classifies
 * each cluster's width via `DefaultClassifier` (see
 * `shared/lib/width/classifier.ts`). This test file locks the key
 * contract that downstream renderers depend on:
 *
 *   - Exactly ONE grid cell per grapheme cluster (width 1 or 2).
 *   - Zero-width combining marks attach to the PRECEDING cluster (their
 *     grapheme text is appended to the cell) and do NOT advance the
 *     cursor.
 *   - Multi-codepoint ZWJ family emoji collapse to a single wide cell.
 *   - Regional-indicator flag sequences collapse to a single wide cell.
 *   - Variation selectors (VS15/VS16) control emoji-presentation width.
 *
 * These tests exercise the emulator end-to-end (feed → grid) rather
 * than the classifier in isolation. That way a regression in the
 * feed→print pipeline (e.g. splitting the UTF-8 decoder output before
 * segmenting) shows up here even if the classifier unit tests still pass.
 *
 * All non-ASCII text is written via explicit `\uXXXX` escapes so the
 * source stays stable across editor autosave / filesystem encodings.
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

  constructor(rows = 3, cols = 20) {
    this.emulator = new VtEmulator({
      sessionId: 'grapheme-test',
      rows,
      cols,
      onEnvelope: (env) => this.envs.push(env),
    });
  }

  feed(s: string | Uint8Array): void {
    const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : s;
    this.emulator.feed(bytes);
  }
}

describe('grapheme-combining — base + combining mark', () => {
  it('`a` + U+0301 (combining acute) lands in one cell, width 1', () => {
    // Invariant: the combining acute attaches to the preceding 'a' cell,
    // producing a single cluster of width 1.
    const h = new Harness();
    const aAcute = 'á';
    h.feed(aAcute);
    const cell = h.emulator._getCell(0, 0);
    expect(cell).toBeDefined();
    expect(cell!.width).toBe(1);
    expect(cell!.grapheme).toBe(aAcute);
    expect(h.emulator._getCursor().col).toBe(1);
  });

  it('multiple stacked combining marks all attach to the preceding base', () => {
    // Invariant: multiple combining marks after the same base accumulate
    // on the same cell. Only the base advances the cursor.
    const h = new Harness();
    const stacked = 'é̂'; // e + acute + circumflex
    h.feed(stacked);
    const cell = h.emulator._getCell(0, 0);
    expect(cell!.grapheme).toBe(stacked);
    expect(cell!.width).toBe(1);
    expect(h.emulator._getCursor().col).toBe(1);
  });

  it('combining mark as the first byte (no base) attaches to cell (0, 0)', () => {
    // Invariant: a combining mark with no preceding grapheme in the same
    // feed still runs through `printGrapheme`. Width classifier returns
    // 'zero', so it attaches to `col - 1`, which is clamped to 0. The
    // resulting cell at col 0 has the combining mark appended.
    const h = new Harness();
    h.feed('́'); // bare combining acute
    expect(h.emulator._getCursor().col).toBe(0);
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.grapheme).toBe('́');
  });
});

describe('grapheme-combining — ZWJ emoji sequences', () => {
  it('family emoji (man + ZWJ + woman + ZWJ + boy) collapses to one width-2 cell', () => {
    // Invariant: ZWJ sequences form a single grapheme cluster; width
    // classifier returns 'two'.
    const h = new Harness();
    // U+1F468 MAN + U+200D ZWJ + U+1F469 WOMAN + U+200D ZWJ + U+1F466 BOY
    const family = '\u{1F468}‍\u{1F469}‍\u{1F466}';
    h.feed(family);
    const lead = h.emulator._getCell(0, 0)!;
    expect(lead.grapheme).toBe(family);
    expect(lead.width).toBe(2);
    // The trailing cell of a wide grapheme has width === 0 (continuation).
    expect(h.emulator._getCell(0, 1)?.width).toBe(0);
    // Cursor advanced by 2 columns.
    expect(h.emulator._getCursor().col).toBe(2);
  });

  it('woman emoji (U+1F469) is width 2, single cell', () => {
    // Invariant: default-emoji-presentation code points are 'two' wide as
    // single clusters.
    const h = new Harness();
    const woman = '\u{1F469}';
    h.feed(woman);
    const lead = h.emulator._getCell(0, 0)!;
    expect(lead.width).toBe(2);
    expect(lead.grapheme).toBe(woman);
    expect(h.emulator._getCursor().col).toBe(2);
  });

  it('keycap sequence `1` + VS16 + U+20E3 is one cell, width 2', () => {
    // Invariant: keycap sequences are grapheme clusters in emoji
    // presentation. Width classifier reports 'two' (VS16 present).
    const h = new Harness();
    const keycap = '1️⃣';
    h.feed(keycap);
    const lead = h.emulator._getCell(0, 0)!;
    expect(lead.grapheme).toBe(keycap);
    expect(lead.width).toBe(2);
    expect(h.emulator._getCursor().col).toBe(2);
  });
});

describe('grapheme-combining — flag / regional indicator sequences', () => {
  it('US flag (U+1F1FA + U+1F1F8) collapses to one width-2 cell', () => {
    // Invariant: two adjacent regional indicators form a single flag
    // grapheme cluster. Width classifier returns 'two'.
    const h = new Harness();
    const usFlag = '\u{1F1FA}\u{1F1F8}';
    h.feed(usFlag);
    const lead = h.emulator._getCell(0, 0)!;
    expect(lead.grapheme).toBe(usFlag);
    expect(lead.width).toBe(2);
    expect(h.emulator._getCursor().col).toBe(2);
  });

  it('two flags in sequence occupy four columns total', () => {
    // Invariant: each flag is its own cluster; neither RI bleeds into the
    // next. 2 flags × 2 cells = 4 columns advanced.
    const h = new Harness();
    const us = '\u{1F1FA}\u{1F1F8}';
    const jp = '\u{1F1EF}\u{1F1F5}';
    h.feed(us + jp);
    expect(h.emulator._getCell(0, 0)!.grapheme).toBe(us);
    expect(h.emulator._getCell(0, 0)!.width).toBe(2);
    expect(h.emulator._getCell(0, 2)!.grapheme).toBe(jp);
    expect(h.emulator._getCell(0, 2)!.width).toBe(2);
    expect(h.emulator._getCursor().col).toBe(4);
  });
});

describe('grapheme-combining — variation selectors', () => {
  it('heart U+2764 + VS15 renders as text presentation (width 1)', () => {
    // Invariant: VS15 forces text presentation → classifier returns 'one'.
    const h = new Harness();
    const heartText = '❤︎';
    h.feed(heartText);
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.grapheme).toBe(heartText);
    expect(cell.width).toBe(1);
    expect(h.emulator._getCursor().col).toBe(1);
  });

  it('heart U+2764 + VS16 renders as emoji presentation (width 2)', () => {
    // Invariant: VS16 forces emoji presentation → classifier returns 'two'.
    const h = new Harness();
    const heartEmoji = '❤️';
    h.feed(heartEmoji);
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.grapheme).toBe(heartEmoji);
    expect(cell.width).toBe(2);
    expect(h.emulator._getCursor().col).toBe(2);
  });
});
