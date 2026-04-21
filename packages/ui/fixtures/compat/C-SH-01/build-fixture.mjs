#!/usr/bin/env node
/**
 * SYNTHETIC C-SH-01 fixture generator — bash: ls, cd /tmp, pwd, echo $?.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream (no live PTY recording
 * yet; `tools/compat-record` still pending per Plan 0005 Epic ε §6).
 *
 * What this fixture adds over the alt-screen-heavy C-ED-* / C-PG-* /
 * C-MUX-* / C-MON-* fixtures: it is PURE MAIN BUFFER. No DECSET 1049.
 * No SGR. Plain shell-loop output that advances the cursor with
 * `\r\n` and scrolls the viewport when rows are exhausted. This is the
 * baseline case — if C-SH-01 fails, everything further up the stack is
 * moot.
 *
 * Scenario
 * --------
 *   1. `$ ` prompt (row 0).
 *   2. `ls\r\n` typed → output `Documents  Downloads  Projects\r\n`.
 *   3. `$ cd /tmp\r\n`.
 *   4. `$ pwd\r\n/tmp\r\n`.
 *   5. `$ echo $?\r\n0\r\n`.
 *   6. Final `$ ` prompt parked at end.
 *
 * Why synthetic?
 *   Real bash emits a handful of terminfo queries and possibly PROMPT_COMMAND
 *   bytes before the first `$ `. None of those are load-bearing for the
 *   "plain main-buffer loop" contract we want to assert.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-SH-01/build-fixture.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const enc = new TextEncoder();

/** Concatenate any mix of `number`, `number[]`, strings into bytes. */
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
// 40 cols × 12 rows keeps everything in one viewport with room to spare,
// so assertions stay stable and row indices don't drift under scroll.
const COLS = 40;
const ROWS = 12;

// Each "command turn" is prompt + command + newline + output (maybe) + newline.
// Row layout after the full sequence (each shell line consumes one grid row):
//   row 0: `$ ls`
//   row 1: `Documents  Downloads  Projects`
//   row 2: `$ cd /tmp`
//   row 3: `$ pwd`
//   row 4: `/tmp`
//   row 5: `$ echo $?`
//   row 6: `0`
//   row 7: `$ ` (cursor parked here)
//
// All rows stay within ROWS=12, so no scroll occurs. Cursor col after `$ `
// is 2.

// ---------- Build the stream incrementally with checkpoints ----------
/** @type {number[]} */
const stream = [];
/**
 * @type {Array<{at_byte_offset: number, description: string,
 *               expected: Record<string, unknown>}>}
 */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// --- Phase 1: first prompt + `ls` + output ---
appendChunk(bytes('$ '));
appendChunk(bytes('ls\r\n'));
appendChunk(bytes('Documents  Downloads  Projects\r\n'));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `ls\\r\\n` + output — row 0 has `$ ls`, row 1 has the three entries, cursor on row 2 col 0.',
  expected: {
    cursor: { row: 2, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ ls', widths: Array(COLS).fill(1) },
      1: {
        text: 'Documents  Downloads  Projects',
        widths: Array(COLS).fill(1),
      },
      2: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- Phase 2: `cd /tmp` — prompt + command; no output ---
appendChunk(bytes('$ cd /tmp\r\n'));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `cd /tmp\\r\\n` — row 2 shows the command; cursor on row 3 col 0.',
  expected: {
    cursor: { row: 3, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      2: { text: '$ cd /tmp', widths: Array(COLS).fill(1) },
      3: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- Phase 3: `pwd` — prompt + command + output `/tmp` ---
appendChunk(bytes('$ pwd\r\n'));
appendChunk(bytes('/tmp\r\n'));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `pwd\\r\\n/tmp\\r\\n` — row 3 has the command, row 4 the output; cursor on row 5 col 0.',
  expected: {
    cursor: { row: 5, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      3: { text: '$ pwd', widths: Array(COLS).fill(1) },
      4: { text: '/tmp', widths: Array(COLS).fill(1) },
      5: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- Phase 4: `echo $?` — prompt + command + `0` output ---
appendChunk(bytes('$ echo $?\r\n'));
appendChunk(bytes('0\r\n'));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `echo $?\\r\\n0\\r\\n` — row 5 has the command, row 6 the `0` output; cursor on row 7 col 0.',
  expected: {
    cursor: { row: 7, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      5: { text: '$ echo $?', widths: Array(COLS).fill(1) },
      6: { text: '0', widths: Array(COLS).fill(1) },
      7: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- Phase 5: final `$ ` prompt parked waiting for input ---
appendChunk(bytes('$ '));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After final `$ ` prompt — cursor parked at row 7 col 2, main buffer holds the full transcript of 4 command turns.',
  expected: {
    cursor: { row: 7, col: 2 },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ ls', widths: Array(COLS).fill(1) },
      1: {
        text: 'Documents  Downloads  Projects',
        widths: Array(COLS).fill(1),
      },
      2: { text: '$ cd /tmp', widths: Array(COLS).fill(1) },
      3: { text: '$ pwd', widths: Array(COLS).fill(1) },
      4: { text: '/tmp', widths: Array(COLS).fill(1) },
      5: { text: '$ echo $?', widths: Array(COLS).fill(1) },
      6: { text: '0', widths: Array(COLS).fill(1) },
      7: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP for scrollback: 8 main rows used, viewport has 12 rows, no scroll → rowCount 0 ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Scrollback invariant — nothing has scrolled off the top, so the scrollback ring is still empty.',
  expected: {
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
  },
});

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
      shell: 'synthetic-bash',
      cols: COLS,
      rows: ROWS,
      description:
        'bash: ls, cd /tmp, pwd, echo $? — pure main-buffer shell loop with no alt-screen, no SGR. Exercises the plain `\\r\\n` + printable code path and verifies cursor advancement across four command turns.',
      authoredAt: '2026-04-21T00:00:00Z',
      synthetic: true,
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `wrote ${stream.length} bytes to input.bytes; ${checkpoints.length} checkpoints.`,
);
