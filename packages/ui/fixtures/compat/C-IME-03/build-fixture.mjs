#!/usr/bin/env node
/**
 * SYNTHETIC C-IME-03 fixture generator — Chinese pinyin IME render side.
 *
 * Plan 0005 P0 Gate #6. Mirrors C-IME-02 (Japanese) but for the
 * CJK-unified-ideograph range. Post-commit PTY bytes `你好世界!` are
 * 4 wide glyphs + 1 narrow bang.
 *
 * Scenario (post-commit bytes only)
 * ---------------------------------
 *   1. `$ echo 你好世界!\r\n`.
 *   2. Echo output `你好世界!\r\n`.
 *   3. Post-output prompt `$ `.
 *
 * Expected widths on row 0 cols 7..14:
 *   [2,0, 2,0, 2,0, 2,0]
 * Narrow `!` at col 15 (width 1); cursor ends at col 16 before newline.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-IME-03/build-fixture.mjs
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
const HANZI = ['你', '好', '世', '界'];
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

// Phase 1: `$ echo 你好世界!\r\n`.
appendChunk(bytes(PROMPT, HANZI.join(''), BANG, '\r\n'));

// --- CP 1: row 0 widths for `你好世界` → [2,0, 2,0, 2,0, 2,0] starting at col 7. ---
// After newline, cursor moves to row 1 col 0.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `$ echo 你好世界!\\r\\n` — row 0 holds the prompt + 4 wide hanzi + narrow `!`; cursor at row 1 col 0.',
  expected: {
    cursor: { row: 1, col: 0 },
    selected_rows: {
      0: {
        text: `${PROMPT}${HANZI.join('')}${BANG}`,
        widths: widthsPrefix(
          1, 1, 1, 1, 1, 1, 1,
          2, 0, 2, 0, 2, 0, 2, 0,
          1,
        ),
      },
    },
  },
});

// Phase 2: echo output.
appendChunk(bytes(HANZI.join(''), BANG, '\r\n'));

// --- CP 2: after newline, row 1 echo same pattern. ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After echo output — row 1 holds `你好世界!` at widths [2,0, 2,0, 2,0, 2,0, 1]; cursor on row 2.',
  expected: {
    cursor: { row: 2, col: 0 },
    selected_rows: {
      1: {
        text: `${HANZI.join('')}${BANG}`,
        widths: widthsPrefix(
          2, 0, 2, 0, 2, 0, 2, 0,
          1,
        ),
      },
    },
  },
});

// Phase 3: post-output prompt `$ `.
appendChunk(bytes('$ '));

// --- CP 3: final prompt at row 2 ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After post-output `$ ` — row 2 holds the fresh prompt; cursor at row 2 col 2.',
  expected: {
    cursor: { row: 2, col: 2 },
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
      shell: 'zsh',
      cols: COLS,
      rows: ROWS,
      description:
        'Chinese pinyin IME post-commit render: `$ echo 你好世界!` lands with each hanzi at width-2/width-0; trailing `!` narrow. Mirrors C-IME-01 / C-IME-02 for the CJK unified ideograph range.',
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
