#!/usr/bin/env node
/**
 * SYNTHETIC C-RP-03 fixture generator — psql `SELECT 1` round-trip.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream; real recording will
 * replace this once `tools/compat-record` lands.
 *
 * Scope: Postgres interactive shell (`psql`) prompt shape + a trivial
 * query round-trip, then clean `\q`.
 *
 * Byte stream (server POV — what psql writes to the PTY):
 *   1. `$ psql mydb\r\n`          (local shell launches psql)
 *   2. `psql (15.3)\r\n`          (banner line 1)
 *   3. `Type "help" for help.\r\n` (banner line 2)
 *   4. `\r\n`                     (blank separator)
 *   5. `mydb=> `                  (initial prompt)
 *   6. `SELECT 1;\r\n`            (echoed command)
 *   7. ` ?column?\r\n`            (result: column header)
 *   8. `----------\r\n`           (separator rule)
 *   9. `        1\r\n`            (result row)
 *  10. `(1 row)\r\n`              (row count)
 *  11. `\r\n`                     (blank separator)
 *  12. `mydb=> `                  (next prompt)
 *  13. `\q\r\n`                   (quit command)
 *  14. `$ `                       (local prompt reprint)
 *
 * Prompt shape
 * ------------
 * psql's prompt is `<dbname>=> ` when not inside a transaction. Inside
 * a transaction it flips to `<dbname>=* `, and during a continued
 * multi-line statement it's `<dbname>-> `. This fixture only exercises
 * the idle `=>` form; the `-*`/`->` variants are out of scope (P1
 * upgrade candidate).
 *
 * Why synthetic?
 * --------------
 * The real psql banner includes compile options, SSL negotiation hints,
 * localisation strings, and readline initialisation bytes that vary
 * wildly by version and distro. We ship a minimal representative
 * banner — fixture-level determinism beats field-level realism here.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-RP-03/build-fixture.mjs
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
const COLS = 40;
const ROWS = 16;

const BANNER_1 = 'psql (15.3)';
const BANNER_2 = 'Type "help" for help.';
const PROMPT = 'mydb=> ';
const COL_HEADER = ' ?column?';
const COL_RULE = '----------';
const RESULT_ROW = '        1';
const ROW_COUNT = '(1 row)';

// Row layout after the whole stream:
//   row 0:  `$ psql mydb`
//   row 1:  BANNER_1
//   row 2:  BANNER_2
//   row 3:  ''           (blank separator)
//   row 4:  `mydb=> SELECT 1;`
//   row 5:  COL_HEADER
//   row 6:  COL_RULE
//   row 7:  RESULT_ROW
//   row 8:  ROW_COUNT
//   row 9:  ''           (blank separator)
//   row 10: `mydb=> \q`
//   row 11: `$ `         (cursor parked at col 2)

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

// --- Phase 1: local prompt + psql launch ---
appendChunk(bytes('$ psql mydb\r\n'));

// --- Phase 2: psql banner + initial prompt ---
appendChunk(bytes(BANNER_1, '\r\n'));
appendChunk(bytes(BANNER_2, '\r\n'));
appendChunk(bytes('\r\n'));
appendChunk(bytes(PROMPT));

// --- CP 1: psql banner + prompt visible ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After psql banner + initial prompt — row 1 holds `psql (15.3)`, row 2 the help hint, row 4 starts with `mydb=> `. Cursor at row 4 col 7.',
  expected: {
    cursor: { row: 4, col: PROMPT.length },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ psql mydb', widths: blankWidths() },
      1: { text: BANNER_1, widths: blankWidths() },
      2: { text: BANNER_2, widths: blankWidths() },
      4: { text: PROMPT, widths: blankWidths() },
    },
  },
});

// --- CP 2: prompt shape `mydb=> ` ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Prompt shape assertion: row 4 starts with `mydb=> ` — psql idle-prompt form (not transaction `=*` or continuation `->`).',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      4: { text: PROMPT, widths: blankWidths() },
    },
  },
});

// --- Phase 3: `SELECT 1;\r\n` + result table ---
appendChunk(bytes('SELECT 1;\r\n'));
appendChunk(bytes(COL_HEADER, '\r\n'));
appendChunk(bytes(COL_RULE, '\r\n'));
appendChunk(bytes(RESULT_ROW, '\r\n'));
appendChunk(bytes(ROW_COUNT, '\r\n'));
appendChunk(bytes('\r\n'));
appendChunk(bytes(PROMPT));

// --- CP 3: result table rows visible ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `SELECT 1;\\r\\n` + result table + next prompt — row 4 echoes the command; rows 5-8 hold header / rule / value / count; row 10 starts the next `mydb=> `.',
  expected: {
    cursor: { row: 10, col: PROMPT.length },
    mode: { altScreen: false },
    selected_rows: {
      4: {
        text: PROMPT + 'SELECT 1;',
        widths: blankWidths(),
      },
      5: { text: COL_HEADER, widths: blankWidths() },
      6: { text: COL_RULE, widths: blankWidths() },
      7: { text: RESULT_ROW, widths: blankWidths() },
      8: { text: ROW_COUNT, widths: blankWidths() },
      10: { text: PROMPT, widths: blankWidths() },
    },
  },
});

// --- Phase 4: `\q\r\n` + local prompt reprint ---
appendChunk(bytes('\\q\r\n'));
appendChunk(bytes('$ '));

// --- CP 4: after `\q`, local prompt back ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `\\q\\r\\n` + local shell reprint — row 10 holds `mydb=> \\q`, row 11 holds `$ `. Cursor parked at row 11 col 2; altScreen never flipped; scrollback still empty.',
  expected: {
    cursor: { row: 11, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      10: { text: PROMPT + '\\q', widths: blankWidths() },
      11: { text: '$ ', widths: blankWidths() },
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
      shell: 'synthetic-psql',
      cols: COLS,
      rows: ROWS,
      description:
        'psql `mydb=> ` prompt shape + `SELECT 1;` round-trip: banner + idle prompt + result table (header / rule / value / row count) + clean `\\q`. Real psql banner and transaction-aware prompt variants (`=*`, `->`) vary by version and are out of scope.',
      authoredAt: '2026-04-21T00:00:00Z',
      kind: 'synthetic',
      id: 'C-RP-03',
      snapshotFormatVersion: 1,
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `wrote ${stream.length} bytes to input.bytes; ${checkpoints.length} checkpoints.`,
);
