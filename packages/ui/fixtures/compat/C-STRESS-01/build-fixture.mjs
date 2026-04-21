#!/usr/bin/env node
/**
 * SYNTHETIC C-STRESS-01 fixture generator — `tail -f /dev/urandom | base64`
 * 30s stress simulation.
 *
 * Plan 0005 P0 Gate #6. Continuous high-volume main-buffer output: 100
 * "seconds" of ~300-char base64-ish lines (~30 KB total). Exercises the
 * main-buffer scroll-up path and the scrollback ring under steady load.
 *
 * Load-bearing invariants
 * -----------------------
 *   - Main-buffer rows that scroll off the top land in the scrollback
 *     ring; `rowCount` grows monotonically with the number of rows
 *     beyond the viewport.
 *   - `altScreen` stays false throughout (this scenario never enters
 *     alt).
 *   - Byte-accounting holds globally (the harness-audit test enforces
 *     `inputBytes === feedBytes + droppedBytes` across the full matrix;
 *     no per-checkpoint assertion needed here).
 *
 * Scenario
 * --------
 *   1. Shell prompt + command echo.
 *   2. 100 base64-lookalike rows, each terminated by `\r\n`.
 *   3. `^C` → post-interrupt prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-STRESS-01/build-fixture.mjs
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
// 80 cols × 24 rows matches the "classic VT100" default. 24 rows means
// any batch of >24 rows of output scrolls the first N-24 into scrollback.
const COLS = 80;
const ROWS = 24;
const LINE_COUNT = 100;

// Deterministic base64-like line, 76 printable chars (classic base64 wrap
// width) + \r\n. Content is fully deterministic so the fixture replays
// bit-identical across runs.
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64ishLine(i) {
  // Simple linear-congruential-ish permutation so adjacent lines differ.
  const start = (i * 31) % 64;
  const body = [];
  for (let j = 0; j < 76; j += 1) {
    body.push(BASE64_ALPHABET.charAt((start + j) % 64));
  }
  return body.join('');
}

// ---------- Assemble stream + checkpoints ----------
/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// Phase 1: prompt + command.
appendChunk(bytes('$ tail -f /dev/urandom | base64\r\n'));

// Phase 2: emit first 10 rows.
for (let i = 0; i < 10; i += 1) {
  appendChunk(bytes(base64ishLine(i), '\r\n'));
}

// --- CP 1: 10 rows emitted, all still in viewport ---
// The prompt consumed row 0; line 0 sits at row 1; line 9 at row 10.
// Cursor ends up at row 11, col 0.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After 10 rows emitted — viewport shows prompt + 10 base64 lines; nothing scrolled off yet.',
  expected: {
    cursor: { row: 11, col: 0 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: {
        text: '$ tail -f /dev/urandom | base64',
        widths: Array(COLS).fill(1),
      },
      1: {
        text: base64ishLine(0),
        widths: Array(COLS).fill(1),
      },
      10: {
        text: base64ishLine(9),
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// Phase 3: emit the remaining 90 rows (11 .. 99).
for (let i = 10; i < LINE_COUNT; i += 1) {
  appendChunk(bytes(base64ishLine(i), '\r\n'));
}

// --- CP 2: 100 rows emitted + prompt row. ---
// Total main-buffer rows consumed = 1 (prompt) + 100 (output lines, each
// terminated by \r\n) = 101 row advances. Rows=24 viewport holds rows
// 0..23; scrollback accumulates one row each time `\n` advances past
// row 23. Empirically: 78 rows in scrollback when all 100 lines are
// emitted. The viewport tail shows line 99 at row 22 (the bottom-most
// completed row before the final \r\n moved the cursor to row 23).
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After all 100 rows emitted — 78 rows scrolled into the scrollback ring; viewport row 22 holds line 99 (tail of the stream).',
  expected: {
    cursor: { row: 23, col: 0 },
    mode: { altScreen: false },
    scrollback: { rowCount: 78 },
    selected_rows: {
      // Viewport row 22 holds line 99 (the final base64 line).
      22: {
        text: base64ishLine(99),
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- CP 3: altScreen stays false. ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'altScreen invariant — tail+base64 never enters the alt buffer.',
  expected: {
    mode: { altScreen: false },
  },
});

// --- CP 4: scrollback growth canary. The harness-audit test enforces
// `inputBytes === feedBytes + droppedBytes` globally (report-level
// byteAccounting), so there's no per-checkpoint assertion for
// droppedBytes. This checkpoint re-asserts the exact scrollback row
// count immediately before the interrupt so we detect any regression
// that drops rows silently on main-buffer scroll.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Byte-accounting / no-emergency-drop invariant is covered globally by harness-audit; this checkpoint re-asserts scrollback count stability before interrupt.',
  expected: {
    scrollback: { rowCount: 78 },
  },
});

// Phase 4: ^C + post-interrupt prompt.
appendChunk(bytes('^C\r\n'));
appendChunk(bytes('$ '));

// --- CP 5: after interrupt, final prompt parked on the last viewport row. ---
// The \r\n after ^C produces one more main-buffer scroll; `$ ` parks the
// cursor at row 23, col 2. Row 22 is now `^C`; row 23 is `$ `.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After ^C + prompt — `^C` at row 22 and final `$ ` at row 23; scrollback=79 (grew by one more from the ^C line scroll-up).',
  expected: {
    cursor: { row: 23, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 79 },
    selected_rows: {
      22: { text: '^C', widths: Array(COLS).fill(1) },
      23: { text: '$ ', widths: Array(COLS).fill(1) },
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
        'tail -f /dev/urandom | base64 30s-style stress: ~30 KB of continuous main-buffer output, 100 rows of base64-lookalike text. Exercises scrollback-ring growth + byte-accounting invariant under steady volume. ^C restores prompt.',
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
