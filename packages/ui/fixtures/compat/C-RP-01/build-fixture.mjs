#!/usr/bin/env node
/**
 * SYNTHETIC C-RP-01 fixture generator — python3 multi-line `def` block.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream; real recording will
 * replace this once `tools/compat-record` lands.
 *
 * Scope: Python REPL primary `>>> ` + continuation `... ` prompt cycle
 * across a multi-line `def` block, plus a subsequent call + result, then
 * clean `exit()`.
 *
 * Byte stream (server POV — what the python process writes to the PTY):
 *
 *   Phase A (banner + primary prompt):
 *     `Python 3.11.5 (main, Aug 24 2023) on darwin\r\n`
 *     `Type "help", "copyright" or "license" for info.\r\n`
 *     `>>> `
 *
 *   Phase B (def block with continuation):
 *     echo `def foo():\r\n`
 *     emit `... `
 *     echo `    return 42\r\n`
 *     emit `... `
 *     echo `\r\n` (blank line closes def)
 *     emit `>>> `
 *
 *   Phase C (call + result):
 *     echo `foo()\r\n`
 *     emit `42\r\n`
 *     emit `>>> `
 *
 *   Phase D (exit):
 *     echo `exit()\r\n`
 *     local `$ ` (shell reprint after python terminates)
 *
 * Banner / prompt strings
 * -----------------------
 * Real python3 banners include compiler + build-date + platform tag, and
 * they vary across patch versions and distros. We pin SHORTER fixed
 * strings that FIT in 60 columns (the real banner is ~110 chars on
 * macOS, which would wrap across two rows and make row-index assertions
 * brittle). This is a deliberate synthesis choice — the wrap path is
 * covered by C-SH-02 and isn't the point of this REPL fixture.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-RP-01/build-fixture.mjs
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
const COLS = 60;
const ROWS = 14;

const BANNER_LINE_1 = 'Python 3.11.5 (main, Aug 24 2023) on darwin';
const BANNER_LINE_2 = 'Type "help", "copyright" or "license" for info.';
const PRIMARY = '>>> ';
const CONT = '... ';

// Row layout after the whole stream:
//   row 0: `$ python3`
//   row 1: BANNER_LINE_1
//   row 2: BANNER_LINE_2
//   row 3: `>>> def foo():`
//   row 4: `...     return 42`
//   row 5: `... `           (continuation prompt; user's blank line echoed)
//   row 6: `>>> foo()`
//   row 7: `42`
//   row 8: `>>> exit()`
//   row 9: `$ `

// ---------- Build stream + checkpoints ----------
/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

function blankWidths() {
  return Array(COLS).fill(1);
}

// --- Phase 1: local prompt + `python3` launch ---
appendChunk(bytes('$ python3\r\n'));

// --- Phase 2: python banner (two lines) + primary prompt ---
appendChunk(bytes(BANNER_LINE_1, '\r\n'));
appendChunk(bytes(BANNER_LINE_2, '\r\n'));
appendChunk(bytes(PRIMARY));

// --- CP 1: banner visible ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After python banner + primary prompt — row 1 holds the `Python 3.11.5 ...` banner line, row 3 starts with `>>> `. Cursor at row 3 col 4.',
  expected: {
    cursor: { row: 3, col: PRIMARY.length },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ python3', widths: blankWidths() },
      1: { text: BANNER_LINE_1, widths: blankWidths() },
      2: { text: BANNER_LINE_2, widths: blankWidths() },
      3: { text: PRIMARY, widths: blankWidths() },
    },
  },
});

// --- CP 2: narrow primary-prompt assertion (`>>> ` on row 3) ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Primary-prompt shape assertion: row 3 starts with `>>> ` (and nothing else yet). Pins the classic Python REPL prompt.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      3: { text: PRIMARY, widths: blankWidths() },
    },
  },
});

// --- Phase 3: `def foo():\r\n` echo + continuation prompt ---
// Python echoes the typed line then emits `... ` on the next row because
// the parser detects a dangling colon.
appendChunk(bytes('def foo():\r\n'));
appendChunk(bytes(CONT));

// --- CP 3: continuation prompt `... ` after `def foo():` ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `def foo():\\r\\n` + continuation prompt — row 3 holds `>>> def foo():`, row 4 starts with `... `. Cursor at row 4 col 4.',
  expected: {
    cursor: { row: 4, col: CONT.length },
    mode: { altScreen: false },
    selected_rows: {
      3: { text: PRIMARY + 'def foo():', widths: blankWidths() },
      4: { text: CONT, widths: blankWidths() },
    },
  },
});

// --- Phase 4: `    return 42\r\n` + another continuation prompt ---
// Four-space indent is the Python convention; the REPL keeps the
// continuation prompt active because it's still inside the def block.
appendChunk(bytes('    return 42\r\n'));
appendChunk(bytes(CONT));

// --- Phase 5: blank line closes the def; primary prompt returns ---
appendChunk(bytes('\r\n'));
appendChunk(bytes(PRIMARY));

// --- Phase 6: call `foo()` + result 42 + next primary prompt ---
appendChunk(bytes('foo()\r\n'));
appendChunk(bytes('42\r\n'));
appendChunk(bytes(PRIMARY));

// --- CP 4: result row `42` + primary prompt returned ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `foo()\\r\\n` + `42\\r\\n` + next `>>> ` — row 6 holds `>>> foo()`, row 7 holds the result `42`, row 8 holds the next primary prompt. Cursor at row 8 col 4.',
  expected: {
    cursor: { row: 8, col: PRIMARY.length },
    mode: { altScreen: false },
    selected_rows: {
      4: { text: CONT + '    return 42', widths: blankWidths() },
      6: { text: PRIMARY + 'foo()', widths: blankWidths() },
      7: { text: '42', widths: blankWidths() },
      8: { text: PRIMARY, widths: blankWidths() },
    },
  },
});

// --- Phase 7: `exit()\r\n` + python terminates + local `$ ` reprint ---
appendChunk(bytes('exit()\r\n'));
appendChunk(bytes('$ '));

// --- CP 5: local `$ ` prompt back on row 9 after exit ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `exit()\\r\\n` + local shell reprint — row 8 holds `>>> exit()`, row 9 holds `$ `. Cursor parked at row 9 col 2; altScreen never flipped; scrollback ring empty.',
  expected: {
    cursor: { row: 9, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      8: { text: PRIMARY + 'exit()', widths: blankWidths() },
      9: { text: '$ ', widths: blankWidths() },
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
      shell: 'synthetic-python3',
      cols: COLS,
      rows: ROWS,
      description:
        'python3 multi-line `def` block: primary `>>> ` + continuation `... ` prompt cycle, function call + `42` result, clean `exit()`. Banner lines trimmed vs. real CPython so the fixture fits in 60 cols without wrap.',
      authoredAt: '2026-04-21T00:00:00Z',
      kind: 'synthetic',
      id: 'C-RP-01',
      snapshotFormatVersion: 1,
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `wrote ${stream.length} bytes to input.bytes; ${checkpoints.length} checkpoints.`,
);
