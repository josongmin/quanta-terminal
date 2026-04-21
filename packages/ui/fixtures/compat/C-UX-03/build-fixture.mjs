#!/usr/bin/env node
/**
 * SYNTHETIC C-UX-03 fixture generator — bracketed-paste round-trip.
 *
 * Plan 0005 P0 Gate #6. Bracketed paste mode (DECSET 2004) wraps pasted
 * text in `CSI 200 ~` … `CSI 201 ~` markers. Those markers are CONTROL
 * bytes: they MUST NOT appear as printable characters in the grid. The
 * payload between them renders normally.
 *
 * This fixture checks that the engine handles the marker sequence
 * correctly: the user's pasted text appears on-grid; the markers do
 * NOT.
 *
 * Scenario
 * --------
 *   1. Prompt `$ echo `.
 *   2. `CSI 200 ~` paste-start.
 *   3. Pasted text `hello world!` + `\r\n`.
 *   4. `CSI 201 ~` paste-end.
 *   5. Shell echoes the pasted content (synthetic — we just emit the
 *      output directly).
 *   6. Final prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-UX-03/build-fixture.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ESC = 0x1b;
const CSI = [ESC, 0x5b];
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

const COLS = 40;
const ROWS = 10;

/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// Phase 1: prompt + partial command (user typed `echo `).
appendChunk(bytes('$ echo '));

// Phase 2: paste-start marker. This is a control sequence — the engine
// should treat it as a private-mode signal, not printable text.
appendChunk(bytes(...CSI, '200~'));

// Phase 3: the pasted payload. After the marker the emulator continues
// to print into the grid at the current cursor position (row 0 col 7).
appendChunk(bytes('hello world!'));

// Phase 4: \r\n inside the paste — common when pasting multi-line
// content. The engine must still advance the cursor.
appendChunk(bytes('\r\n'));

// Phase 5: paste-end marker.
appendChunk(bytes(...CSI, '201~'));

// --- CP 1: markers stripped, payload visible on row 0. ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After paste end — row 0 shows `$ echo hello world!`; the CSI 200 ~ and CSI 201 ~ markers must NOT appear as printable cells.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ echo hello world!',
        widths: Array(COLS).fill(1),
      },
      1: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 6: shell "executes" and emits the echoed output. Synthetic —
// we're not running a real shell; just model what the terminal would
// display after the user hits Enter.
appendChunk(bytes('hello world!\r\n'));

// --- CP 2: echo output visible on row 1. ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After shell echo — row 1 contains the echoed `hello world!`; the paste payload round-trips cleanly.',
  expected: {
    cursor: { row: 2, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ echo hello world!',
        widths: Array(COLS).fill(1),
      },
      1: { text: 'hello world!', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 7: final prompt.
appendChunk(bytes('$ '));

// --- CP 3: prompt parked, altScreen false. ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Final `$ ` at row 2. altScreen stays false throughout — bracketed paste is an input-side mode, not a buffer switch.',
  expected: {
    cursor: { row: 2, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      2: { text: '$ ', widths: Array(COLS).fill(1) },
    },
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
      shell: 'synthetic-bash-like',
      cols: COLS,
      rows: ROWS,
      description:
        'Bracketed-paste (DECSET 2004) round-trip: `CSI 200 ~` + `hello world!` + `CSI 201 ~`. Pasted text renders normally; the markers MUST be consumed as control bytes and never appear in the grid.',
      authoredAt: '2026-04-21T00:00:00Z',
      kind: 'synthetic',
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `wrote ${stream.length} bytes to input.bytes; ${checkpoints.length} checkpoints.`,
);
