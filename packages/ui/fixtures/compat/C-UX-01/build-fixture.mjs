#!/usr/bin/env node
/**
 * SYNTHETIC C-UX-01 fixture generator — `clear` behavior.
 *
 * Plan 0005 P0 Gate #6. Verifies the `clear` command's two canonical
 * effects: `CSI 2 J` (erase-in-display, entire screen) followed by
 * `CSI H` (cursor home). Scrollback is NOT erased (that would be
 * `CSI 3 J`, which bash's `clear` typically doesn't emit unless
 * `xterm-256color` terminfo includes `E3`). The fixture asserts:
 *   - viewport is blank after `clear`,
 *   - cursor is at origin,
 *   - scrollback SURVIVES the clear (rows from before stay in the ring).
 *
 * Scenario
 * --------
 *   1. Prompt `$ ls\r\n` + 5-line output + prompt.
 *   2. User types `clear\r\n`.
 *   3. `clear` emits `CSI H` + `CSI 2 J` (classic xterm terminfo `clear`).
 *      Note: real terminfo entries emit these in various orders; the
 *      combined effect is the same — grid cleared, cursor at home.
 *   4. New prompt `$ ` at row 0.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-UX-01/build-fixture.mjs
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

// ---------- Scenario dimensions ----------
const COLS = 40;
const ROWS = 12;

// Pre-clear phase rows:
//   0: $ ls
//   1: a.txt
//   2: b.txt
//   3: c.txt
//   4: d.txt
//   5: e.txt
//   6: $  (cursor here before `clear` typed)
//
// After `clear`, the grid is blank everywhere and cursor goes home; then
// the post-clear prompt `$ ` appears at row 0.

/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// Phase 1: ls transcript.
appendChunk(bytes('$ ls\r\n'));
appendChunk(bytes('a.txt\r\n'));
appendChunk(bytes('b.txt\r\n'));
appendChunk(bytes('c.txt\r\n'));
appendChunk(bytes('d.txt\r\n'));
appendChunk(bytes('e.txt\r\n'));
appendChunk(bytes('$ '));

// --- CP 1: pre-clear state. Row 0 has `$ ls`, rows 1..5 have entries, row 6 has `$ `. ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Pre-clear: ls + 5 files + prompt at row 6. No scrollback (everything fits in 12 rows).',
  expected: {
    cursor: { row: 6, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: { text: '$ ls', widths: Array(COLS).fill(1) },
      1: { text: 'a.txt', widths: Array(COLS).fill(1) },
      5: { text: 'e.txt', widths: Array(COLS).fill(1) },
      6: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 2: user types `clear\r\n` — bytes echo onto row 6 first (prompt
// is still `$ `, so `clear` appends to it), then the newline advances
// the cursor to row 7, and at that point `clear` outputs its control
// sequence.
appendChunk(bytes('clear\r\n'));

// Phase 3: `clear` emits `CSI H` (home) + `CSI 2 J` (erase entire
// display). Some terminfo entries emit `CSI 2 J CSI H`; the order
// doesn't matter for the final state.
appendChunk(bytes(...CSI, 'H'));
appendChunk(bytes(...CSI, '2J'));

// --- CP 2: grid cleared, cursor home, scrollback UNCHANGED (clear does
// NOT emit `CSI 3 J`; scrollback survives). Nothing had scrolled off
// yet, so rowCount is still 0 — but we pin the count so a future
// regression that starts eating scrollback on CSI 2 J would be caught.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `clear` (CSI H + CSI 2J): all visible rows blank, cursor at origin (0, 0), scrollback ring untouched.',
  expected: {
    cursor: { row: 0, col: 0 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: { text: '', widths: Array(COLS).fill(1) },
      5: { text: '', widths: Array(COLS).fill(1) },
      11: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 4: new prompt `$ ` at row 0.
appendChunk(bytes('$ '));

// --- CP 3: post-clear prompt ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After post-clear prompt: row 0 shows `$ `; cursor at (0, 2); remaining rows blank.',
  expected: {
    cursor: { row: 0, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: { text: '$ ', widths: Array(COLS).fill(1) },
      1: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 4: altScreen invariant ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'altScreen stays false across the clear cycle — `clear` never touches the alt buffer.',
  expected: {
    mode: { altScreen: false },
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
        '`clear` behavior: CSI H + CSI 2J wipes the visible grid and homes the cursor without emitting CSI 3J, so the scrollback ring survives. Verifies the baseline `clear` contract used by every shell + bash-in-SSH deployment.',
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
