#!/usr/bin/env node
/**
 * SYNTHETIC C-UX-02 fixture generator — resize cycle (main-buffer reflow).
 *
 * Plan 0005 P0 Gate #6 closing. Exercises the compat harness's in-stream
 * `resize` hook (see `compat-replay.ts` CheckpointExpected.resize) across
 * 10 cycles alternating between 80×24 (the fixture's baseline) and
 * 200×50 (the stretch dim). After each resize, the main-buffer content
 * must be preserved byte-for-byte at the same row indices — the emulator
 * copies `min(oldRows, newRows) × min(oldCols, newCols)` cells into the
 * new grid (see `VtEmulator.resize()`).
 *
 * Scenario
 * --------
 * The byte stream is minimal:
 *    `$ ls\r\n` + 10 output rows (`a.txt` … `j.txt`) + `$ `.
 * All 11 checkpoints fire at the SAME byte-offset (end of stream); we're
 * testing the resize op, NOT byte-stream streaming semantics.
 *
 * Cycle pattern
 * -------------
 *   CP0 : baseline         (80 × 24)  — no resize, sanity anchor.
 *   CP1 : resize to 200×50 (content preserved, new rows/cols blank).
 *   CP2 : resize to 80×24  (content preserved, truncation on col 80..199
 *                           dropped but row 0..11 intact).
 *   CP3 .. CP10: 4 more alternating cycles (5 total round-trips).
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-UX-02/build-fixture.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const enc = new TextEncoder();

function bytes(...parts) {
  /** @type {number[]} */
  const out = [];
  for (const p of parts) {
    if (typeof p === 'string') {
      for (const b of enc.encode(p)) out.push(b);
    } else if (typeof p === 'number') {
      out.push(p);
    } else {
      for (const b of p) out.push(b);
    }
  }
  return out;
}

// ---------- Scenario dimensions ----------
const COLS_BASE = 80;
const ROWS_BASE = 24;
const COLS_WIDE = 200;
const ROWS_WIDE = 50;

// The 10 output rows + `$ ls` + trailing `$ `. We keep row texts short
// (<= 6 chars) so they fit in both 80 and 200 cols without reflow
// complications; resize of a row narrower than `newCols` is pure
// "copy the leading cells, blank-fill the rest".
const OUTPUT_ROWS = [
  'a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt',
  'f.txt', 'g.txt', 'h.txt', 'i.txt', 'j.txt',
];

/** @type {number[]} */
const stream = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

appendChunk(bytes('$ ls\r\n'));
for (const row of OUTPUT_ROWS) {
  appendChunk(bytes(`${row}\r\n`));
}
appendChunk(bytes('$ '));

// Every checkpoint fires at the end of the stream.
const END = stream.length;

/**
 * Build a widths array of `cols` 1s — ASCII-only content, no wide cells.
 * Centralised so the 11 checkpoint objects stay readable.
 */
function widthsFor(cols) {
  return Array(cols).fill(1);
}

/**
 * Build `selected_rows` for the given dimensions. We pin:
 *  - row 0:      `$ ls`       (command echo)
 *  - row 1:      `a.txt`      (first output row)
 *  - row 5:      `e.txt`      (mid output — catches partial preservation bugs)
 *  - row 10:     `j.txt`      (last output)
 *  - row 11:     `$ `         (trailing prompt)
 */
function selectedRowsFor(cols) {
  const w = widthsFor(cols);
  return {
    0:  { text: '$ ls', widths: w },
    1:  { text: 'a.txt', widths: w },
    5:  { text: 'e.txt', widths: w },
    10: { text: 'j.txt', widths: w },
    11: { text: '$ ', widths: w },
  };
}

/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

// ---- CP0: baseline 80×24 (no resize hook). ----
checkpoints.push({
  at_byte_offset: END,
  description: 'Baseline 80×24: ls transcript rendered at fixture meta dims.',
  expected: {
    cursor: { row: 11, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: selectedRowsFor(COLS_BASE),
  },
});

// ---- CP1..CP10: alternate 200×50, 80×24, ... 10 resize operations. ----
// Pattern: odd index → wide, even index → base. That way we ALWAYS end
// back at 80×24 after the 10th resize, leaving a clean post-fixture
// state.
for (let i = 1; i <= 10; i += 1) {
  const wide = i % 2 === 1; // CP1, CP3, ... are wide
  const cols = wide ? COLS_WIDE : COLS_BASE;
  const rows = wide ? ROWS_WIDE : ROWS_BASE;
  const dimTag = `${cols}×${rows}`;
  checkpoints.push({
    at_byte_offset: END,
    description: `Cycle ${i}/10: resize to ${dimTag}, main-buffer content preserved.`,
    expected: {
      resize: { cols, rows },
      scrollback: { rowCount: 0 },
      selected_rows: selectedRowsFor(cols),
    },
  });
}

// ---------- Write artifacts ----------
const inputPath = join(__dirname, 'input.bytes');
const checkpointsPath = join(__dirname, 'checkpoints.json');
const metaPath = join(__dirname, 'meta.json');

writeFileSync(inputPath, Uint8Array.from(stream));
writeFileSync(
  checkpointsPath,
  JSON.stringify(checkpoints, null, 2) + '\n',
);
writeFileSync(
  metaPath,
  JSON.stringify(
    {
      shell: 'synthetic-bash-like',
      cols: COLS_BASE,
      rows: ROWS_BASE,
      description:
        'Resize cycle: 10 alternating resizes between 80×24 and 200×50. Main-buffer content preserved across every cycle; cursor clamped per emulator contract; scrollback ring untouched. Exercises the compat harness in-stream `resize` hook.',
      authoredAt: '2026-04-21T00:00:00Z',
      kind: 'synthetic',
      id: 'C-UX-02',
      snapshotFormatVersion: 1,
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `wrote ${stream.length} bytes to input.bytes; ${checkpoints.length} checkpoints.`,
);
