#!/usr/bin/env node
/**
 * SYNTHETIC C-IME-02 fixture generator — Japanese IME render side.
 *
 * Plan 0005 P0 Gate #6. Mirrors C-IME-01 (Korean) but for hiragana.
 * Each hiragana glyph is classified as East-Asian-Wide and renders
 * as a width-2 leading cell + width-0 continuation; the narrow ASCII
 * `!` afterward lands at col 17 width 1.
 *
 * Scenario (post-commit bytes only)
 * ---------------------------------
 *   1. Prompt `$ echo ` (7 narrow ASCII chars).
 *   2. `こんにちは` — 5 hiragana, each width-2 (10 cells total).
 *   3. `!` (width 1) — lands at col 17.
 *   4. Newline + echo output `\r\nこんにちは!\r\n`.
 *
 * Load-bearing assertion
 * ----------------------
 *   Row 0 widths[0..17] =
 *     [1,1,1,1,1,1,1, 2,0, 2,0, 2,0, 2,0, 2,0, 1]
 *   Row 0 cursor ends at col 18 (after `!`).
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-IME-02/build-fixture.mjs
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
const ROWS = 4;

const PROMPT = '$ echo ';
const HIRAGANA = ['こ', 'ん', 'に', 'ち', 'は'];
const BANG = '!';

function widthsPrefix(...prefix) {
  const out = new Array(COLS).fill(1);
  for (let i = 0; i < prefix.length; i += 1) {
    out[i] = prefix[i];
  }
  return out;
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

// Phase 1: prompt + hiragana + bang.
appendChunk(bytes(PROMPT, HIRAGANA.join(''), BANG));

// --- CP 1: row 0 has `$ echo ` + 5 hiragana + `!` at the right column. ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `$ echo こんにちは!` — row 0 has the prompt, 5 wide hiragana, and the narrow `!` at col 17; cursor at col 18.',
  expected: {
    cursor: { row: 0, col: 18 },
    selected_rows: {
      0: {
        text: `${PROMPT}${HIRAGANA.join('')}${BANG}`,
        widths: widthsPrefix(
          1, 1, 1, 1, 1, 1, 1,
          2, 0, 2, 0, 2, 0, 2, 0, 2, 0,
          1,
        ),
      },
    },
  },
});

// Phase 2: newline + echo output.
appendChunk(bytes('\r\n', HIRAGANA.join(''), BANG, '\r\n'));

// --- CP 2 + CP 3: after newline + echo, row 1 has echoed text at
//  identical widths; row 2 holds the cursor (no prompt reprint yet). ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After newline + echo output — row 1 holds `こんにちは!` at identical wide-cell widths; cursor on row 2 col 0.',
  expected: {
    cursor: { row: 2, col: 0 },
    selected_rows: {
      0: {
        text: `${PROMPT}${HIRAGANA.join('')}${BANG}`,
        widths: widthsPrefix(
          1, 1, 1, 1, 1, 1, 1,
          2, 0, 2, 0, 2, 0, 2, 0, 2, 0,
          1,
        ),
      },
      1: {
        text: `${HIRAGANA.join('')}${BANG}`,
        widths: widthsPrefix(
          2, 0, 2, 0, 2, 0, 2, 0, 2, 0,
          1,
        ),
      },
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
      shell: 'zsh',
      cols: COLS,
      rows: ROWS,
      description:
        'Japanese IME post-commit render: `$ echo こんにちは!` lands on row 0 with each hiragana at width-2/width-0; trailing `!` narrow. Mirrors C-IME-01 for the JP range.',
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
