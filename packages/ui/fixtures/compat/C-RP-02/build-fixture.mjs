#!/usr/bin/env node
/**
 * SYNTHETIC C-RP-02 fixture generator — node REPL multi-line paste.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream; real recording will
 * replace this once `tools/compat-record` lands.
 *
 * Scope: Node REPL with a bracketed-paste block delivering a multi-line
 * arrow-function definition + a call, followed by the result `5`, then
 * clean `.exit`.
 *
 * Bracketed-paste handling
 * ------------------------
 * This fixture *includes* the `CSI 200~` / `CSI 201~` bracketed-paste
 * delimiters in `input.bytes`. The current engine does NOT implement
 * bracketed-paste state (see `VtEmulator.ts` — `bracketed_paste` is on
 * the α2 extension wishlist, not yet wired). Unknown CSI finals with a
 * `~` terminator fall through the parser's "garbage — drop the CSI"
 * branch (VtEmulator.ts L~740) and are silently consumed.
 *
 * That behaviour is exactly what we want the compat harness to assert
 * TODAY: pasted content must render inline on the main buffer unchanged
 * by the delimiter markers. If a future α2 change adds bracketed-paste
 * state tracking, the visible transcript must NOT regress — this fixture
 * is the canary. At that point a P1 fixture will additionally assert the
 * `bracketed_paste_on` mode flag; this one stays focused on "visible
 * transcript unchanged".
 *
 * Why `5\r\n> ` directly (no realistic line-by-line echo)?
 * --------------------------------------------------------
 * Real node-v20 REPL echoes each pasted line prefixed with `... ` for
 * incomplete blocks, then emits `undefined` + `5` + `> ` after the
 * final `add(2, 3)`. That's 10+ extra rows of state drift that isn't
 * load-bearing for the "paste-markers are transparent" contract under
 * test. We synthesise a tidier stream: paste content lands as raw text,
 * result `5` on its own row, next `> `.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-RP-02/build-fixture.mjs
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
const COLS = 60;
const ROWS = 12;

const BANNER_LINE_1 = 'Welcome to Node.js v20.9.0.';
const BANNER_LINE_2 = 'Type ".help" for more information.';
const PRIMARY = '> ';

// Bracketed paste sequences. Each is CSI `200~` / `201~` — unknown CSI
// finals that the engine's parser consumes + drops.
const PASTE_START = [...CSI, ...enc.encode('200~')];
const PASTE_END = [...CSI, ...enc.encode('201~')];

// Pasted content, line by line. We keep each line short enough to land
// within 60 cols without re-wrapping (the paste markers themselves add
// no visible cells, so the effective widths are just the text widths).
const PASTE_LINE_1 = 'const add = (a, b) => {';
const PASTE_LINE_2 = '  return a + b;';
const PASTE_LINE_3 = '};';
const PASTE_LINE_4 = 'add(2, 3)';

// Row layout after the whole stream:
//   row 0: `$ node`
//   row 1: BANNER_LINE_1
//   row 2: BANNER_LINE_2
//   row 3: `> const add = (a, b) => {`    (paste line 1, with prompt still at cols 0..1)
//   row 4: `  return a + b;`              (paste line 2)
//   row 5: `};`                           (paste line 3)
//   row 6: `add(2, 3)`                    (paste line 4)
//   row 7: `5`                            (result)
//   row 8: `> .exit`                      (next primary prompt + exit)
//   row 9: `$ `                           (local shell reprint; cursor col 2)

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

// --- Phase 1: local prompt + `node` launch ---
appendChunk(bytes('$ node\r\n'));

// --- Phase 2: node banner + primary `> ` prompt ---
appendChunk(bytes(BANNER_LINE_1, '\r\n'));
appendChunk(bytes(BANNER_LINE_2, '\r\n'));
appendChunk(bytes(PRIMARY));

// --- CP 1: banner visible ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After node banner + primary prompt — row 1 holds the welcome line, row 2 the help hint, row 3 starts with `> `.',
  expected: {
    cursor: { row: 3, col: PRIMARY.length },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ node', widths: blankWidths() },
      1: { text: BANNER_LINE_1, widths: blankWidths() },
      2: { text: BANNER_LINE_2, widths: blankWidths() },
      3: { text: PRIMARY, widths: blankWidths() },
    },
  },
});

// --- CP 2: narrow primary-prompt assertion (`> ` on row 3) ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Primary-prompt shape assertion: row 3 starts with `> ` (node REPL primary). Pins the exact prompt bytes at the expected offset.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      3: { text: PRIMARY, widths: blankWidths() },
    },
  },
});

// --- Phase 3: bracketed paste (markers dropped by parser) ---
// Sequence: PASTE_START + line1 + CRLF + line2 + CRLF + line3 + CRLF +
// line4 + CRLF + PASTE_END. The two CSI 200~/201~ markers are silently
// consumed; all four lines land on rows 3..6 inline.
appendChunk(bytes(PASTE_START));
appendChunk(bytes(PASTE_LINE_1, '\r\n'));
appendChunk(bytes(PASTE_LINE_2, '\r\n'));
appendChunk(bytes(PASTE_LINE_3, '\r\n'));
appendChunk(bytes(PASTE_LINE_4, '\r\n'));
appendChunk(bytes(PASTE_END));

// --- Phase 4: node emits `5\r\n> ` (result + next prompt) ---
appendChunk(bytes('5\r\n'));
appendChunk(bytes(PRIMARY));

// --- CP 3: result row `5` + next prompt + paste landed correctly ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After bracketed paste + result — row 3 holds `> const add = (a, b) => {` (paste markers consumed transparently), rows 4-6 hold the rest of the paste, row 7 holds the `5` result, row 8 starts with the next `> `.',
  expected: {
    cursor: { row: 8, col: PRIMARY.length },
    mode: { altScreen: false },
    selected_rows: {
      3: { text: PRIMARY + PASTE_LINE_1, widths: blankWidths() },
      4: { text: PASTE_LINE_2, widths: blankWidths() },
      5: { text: PASTE_LINE_3, widths: blankWidths() },
      6: { text: PASTE_LINE_4, widths: blankWidths() },
      7: { text: '5', widths: blankWidths() },
      8: { text: PRIMARY, widths: blankWidths() },
    },
  },
});

// --- Phase 5: `.exit\r\n` + local `$ ` reprint ---
appendChunk(bytes('.exit\r\n'));
appendChunk(bytes('$ '));

// --- CP 4: local prompt back on row 9; altScreen stayed false ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `.exit\\r\\n` + local shell reprint — row 8 holds `> .exit`, row 9 holds `$ `. Cursor parked at row 9 col 2. altScreen never flipped; scrollback ring still empty.',
  expected: {
    cursor: { row: 9, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      8: { text: PRIMARY + '.exit', widths: blankWidths() },
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
      shell: 'synthetic-node',
      cols: COLS,
      rows: ROWS,
      description:
        'node REPL multi-line paste: bracketed-paste delimiters (CSI 200~ / CSI 201~) are silently consumed by the parser, the pasted arrow-function definition lands inline on rows 3-6, result `5` on row 7, next `> ` on row 8, clean `.exit`. Canary for future bracketed-paste state tracking (must not regress visible transcript).',
      authoredAt: '2026-04-21T00:00:00Z',
      kind: 'synthetic',
      id: 'C-RP-02',
      snapshotFormatVersion: 1,
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `wrote ${stream.length} bytes to input.bytes; ${checkpoints.length} checkpoints.`,
);
