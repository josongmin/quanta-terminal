#!/usr/bin/env node
/**
 * SYNTHETIC C-SH-02 fixture generator — zsh with a long hostname prompt.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream (no live PTY recording
 * yet; `tools/compat-record` pending per Plan 0005 Epic ε §6).
 *
 * What this fixture adds over C-SH-01
 * -----------------------------------
 * C-SH-01 covers the no-wrap baseline. C-SH-02 stresses DECAWM
 * (auto-wrap at the right margin) with an explicit 91-character zsh
 * prompt at cols=80. The prompt is >80 bytes so it HAS to straddle two
 * grid rows.
 *
 * DECAWM contract under test
 * --------------------------
 *   - Writing 80 printable cells fills cols 0..79 of row 0 and flips
 *     `pendingWrap = true`. Cursor col remains 79.
 *   - The 81st printable triggers the wrap: col resets to 0, row
 *     advances to 1, and the char writes at row 1 col 0.
 *   - With a 91-char prompt we therefore expect row 0 full, row 1
 *     cols 0..10 holding the prompt tail (11 chars), cursor at
 *     row 1 col 11.
 *
 * Scenario
 * --------
 *   1. Emit the 91-char prompt (no CR/LF). Row 0 fills, row 1 receives
 *      the continuation.
 *   2. User types `ls\r\n`. Two printables land on row 1 at cols 11-12,
 *      then `\r` returns to col 0, `\n` drops to row 2.
 *   3. One-line output `README  src\r\n` on row 2.
 *   4. Emit the SAME 91-char prompt again as a "next prompt" to verify
 *      the wrap behaves consistently after scrolling one row deep.
 *
 * Why zsh specifically? The stream is indistinguishable from any shell
 * with a long `PS1`; we name it zsh because zsh's default prompt is
 * where most users first hit the 80-col wrap pain. No zsh-specific
 * escape sequences are needed.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-SH-02/build-fixture.mjs
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
// The whole point of this fixture is to stress the cols=80 wrap path.
const COLS = 80;
const ROWS = 24;

// Exactly 91 characters — long enough to cross one row (80 + 11) but
// short enough that the continuation fits on the next row without
// re-wrapping. Verified via `.length` below.
const PROMPT = 'user@very-long-hostname-that-goes-on-and-on-and-on-and-on-and-on-and-on-and-on-very-long % ';
if (PROMPT.length !== 91) {
  throw new Error(`PROMPT must be exactly 91 chars; got ${PROMPT.length}`);
}

// Row 0 receives cols 0..79 (the first 80 chars of PROMPT).
const PROMPT_ROW_0 = PROMPT.slice(0, COLS);
// Row 1 receives cols 0..10 (the remaining 11 chars).
const PROMPT_ROW_1 = PROMPT.slice(COLS);
if (PROMPT_ROW_1.length !== PROMPT.length - COLS) {
  throw new Error('prompt slice arithmetic is wrong');
}

// ---------- Build the stream + checkpoints ----------
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

function blankWidths() {
  return Array(COLS).fill(1);
}

// --- CP 1: after the first wrapped prompt is written ---
appendChunk(bytes(PROMPT));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After the 91-char prompt is written: row 0 is full (cols 0..79), row 1 holds the 11-char continuation. Cursor at row 1 col 11.',
  expected: {
    cursor: { row: 1, col: PROMPT_ROW_1.length },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: PROMPT_ROW_0, widths: blankWidths() },
      1: { text: PROMPT_ROW_1, widths: blankWidths() },
    },
  },
});

// --- CP 2: after user types `ls` (no newline yet) ---
appendChunk(bytes('ls'));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `ls` echoed onto the wrapped prompt row — cursor at row 1 col 13 (prompt tail 11 + `ls` 2).',
  expected: {
    cursor: { row: 1, col: PROMPT_ROW_1.length + 2 },
    mode: { altScreen: false },
    selected_rows: {
      // Row 1 now reads PROMPT_ROW_1 + 'ls'.
      1: {
        text: PROMPT_ROW_1 + 'ls',
        widths: blankWidths(),
      },
    },
  },
});

// --- CP 3: after `\r\n` + output line + next prompt ---
// The output + second prompt paint covers: `\r\n` drops to row 2 col 0,
// one-line output + `\r\n` lands on row 2 and advances to row 3, then
// the 91-char prompt wraps again — row 3 fills, row 4 gets the tail.
appendChunk(bytes('\r\n'));
appendChunk(bytes('README  src\r\n'));
appendChunk(bytes(PROMPT));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `ls` enters, output prints, and a second 91-char prompt re-wraps: row 0 and row 1 still hold the first prompt; row 2 is the output; row 3 and row 4 hold the second wrapped prompt. Cursor at row 4 col 11.',
  expected: {
    cursor: { row: 4, col: PROMPT_ROW_1.length },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: PROMPT_ROW_0, widths: blankWidths() },
      // Row 1 retains the first prompt's tail + the `ls` the user typed
      // — those cells were written before `\r\n` reset the cursor to the
      // next row, so they stay on row 1.
      1: {
        text: PROMPT_ROW_1 + 'ls',
        widths: blankWidths(),
      },
      2: { text: 'README  src', widths: blankWidths() },
      3: { text: PROMPT_ROW_0, widths: blankWidths() },
      4: { text: PROMPT_ROW_1, widths: blankWidths() },
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
      shell: 'synthetic-zsh',
      cols: COLS,
      rows: ROWS,
      description:
        'zsh with a 91-character hostname-in-prompt wrapping at the 80-column right margin: tests DECAWM auto-wrap — prompt fills row 0, continues on row 1, command echoes on row 1, and a second prompt re-wraps identically deeper in the transcript.',
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
