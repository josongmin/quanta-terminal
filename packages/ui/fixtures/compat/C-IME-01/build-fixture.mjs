#!/usr/bin/env node
/**
 * SYNTHETIC C-IME-01 fixture generator — Korean 2-set IME render side.
 *
 * Plan 0005 P0 Epic ε. This fixture tests the EMULATOR'S render side of
 * CJK wide characters, NOT the IME state machine. Once the host's IME
 * layer commits a composed syllable, the PTY sees raw UTF-8 bytes for
 * the hangul syllable; those bytes must land in the grid as a
 * width-2 leading cell + width-0 continuation cell, and the cursor must
 * advance by 2 columns per syllable.
 *
 * The IME state machine itself (ㅇ + ㅏ + ㄴ → 안, with backspace
 * handling, commit-on-switch, etc.) is covered by a separate spec:
 *   `packages/ui/src/features/input/ime/__tests__/korean-2set.test.ts`
 *
 * Scenario (post-commit bytes only)
 * ---------------------------------
 *   1. Shell prompt `$ echo ` (7 narrow ASCII chars, no newline).
 *   2. Write `안` — cursor at col 7 before; cell[0,7]=width 2
 *      grapheme `'안'`; cell[0,8]=width 0 (continuation); cursor →col 9.
 *   3. Continue with `녕하세요` — 4 more hangul, each 2 cells.
 *   4. Write narrow `!` — lands at col 17 width 1; cursor → col 18.
 *   5. Newline + echo output `\r\n안녕하세요!\r\n`.
 *
 * Loading-bearing assertion
 * -------------------------
 *   CP 5's `widths` array on row 0 must be:
 *     [1,1,1,1,1,1,1, 2,0, 2,0, 2,0, 2,0, 2,0, 1]
 *   for columns 0..17, followed by 22 default-narrow (1) entries filling
 *   out to COLS=40. If the classifier ever misclassifies a hangul as
 *   narrow, or the emulator drops the continuation cell, this array
 *   breaks in a loud, diff-able way.
 *
 * Why no sgrDigest?
 * IME commit doesn't touch SGR state — all cells stay default. `widths`
 * is the only non-trivial projection field here.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-IME-01/build-fixture.mjs
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

// Prompt is deliberately short + no newline yet. "echo " includes the
// trailing space so the cursor lands at col 7 when CP 1 fires.
const PROMPT = '$ echo ';
const HANGUL = ['안', '녕', '하', '세', '요'];
const BANG = '!';

// ---------- Phase bytes ----------
const promptBytes = bytes(PROMPT);
const firstHangulBytes = bytes(HANGUL[0]);
const remainingHangulBytes = bytes(HANGUL.slice(1).join(''));
const bangBytes = bytes(BANG);
const newlineBytes = bytes('\r\n');
const echoOutputBytes = bytes(`${HANGUL.join('')}${BANG}\r\n`);

// ---------- Widths helpers ----------
/** `[a,b,c,...]` padded with `1`s up to length `COLS`. */
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
/**
 * @type {Array<{at_byte_offset: number, description: string,
 *               expected: Record<string, unknown>}>}
 */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// --- CP 1: after `$ echo ` on row 0 — cursor at col 7 ---
// 7 narrow cells written; cursor advances by 1 per cell.
appendChunk(promptBytes);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `$ echo ` (7 narrow ASCII chars) — cursor at row 0 col 7, row 0 holds the prompt text.',
  expected: {
    cursor: { row: 0, col: 7 },
    selected_rows: {
      0: {
        text: '$ echo ',
        widths: widthsPrefix(1, 1, 1, 1, 1, 1, 1),
      },
    },
  },
});

// --- CP 2: after first hangul `안` — col 7 width 2, col 8 width 0 ---
appendChunk(firstHangulBytes);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After first hangul `안` — row 0 col 7 is width-2 leading (grapheme `안`); col 8 is width-0 continuation; cursor advances to col 9.',
  expected: {
    cursor: { row: 0, col: 9 },
    selected_rows: {
      0: {
        // `projectRow` joins graphemes with continuations silently
        // dropping (since their grapheme is ''). So text is literal
        // prompt + one hangul.
        text: `${PROMPT}${HANGUL[0]}`,
        widths: widthsPrefix(1, 1, 1, 1, 1, 1, 1, 2, 0),
      },
    },
  },
});

// --- CP 3: after all 5 hangul — cursor col = 7 + 5*2 = 17 ---
appendChunk(remainingHangulBytes);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After all 5 hangul `안녕하세요` — cursor col = 7 + 5*2 = 17; each hangul occupies a width-2/width-0 pair.',
  expected: {
    cursor: { row: 0, col: 17 },
    selected_rows: {
      0: {
        text: `${PROMPT}${HANGUL.join('')}`,
        widths: widthsPrefix(
          1, 1, 1, 1, 1, 1, 1,
          2, 0, 2, 0, 2, 0, 2, 0, 2, 0,
        ),
      },
    },
  },
});

// --- CP 4: after narrow `!` — lands at col 17 width 1, cursor → col 18 ---
appendChunk(bangBytes);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After narrow `!` — `!` is at col 17 width 1; cursor at col 18. Width boundary is respected: narrow cell after width-0 continuation.',
  expected: {
    cursor: { row: 0, col: 18 },
    selected_rows: {
      0: {
        text: `${PROMPT}${HANGUL.join('')}${BANG}`,
        widths: widthsPrefix(
          1, 1, 1, 1, 1, 1, 1,
          2, 0, 2, 0, 2, 0, 2, 0, 2, 0,
          1,
        ),
      },
    },
  },
});

// --- CP 5: after newline + echo output (post-command) ---
// The shell echoes `$ echo 안녕하세요!\n안녕하세요!\n`. Row 1 becomes
// the output line. Cursor ends at row 2 col 0.
appendChunk(newlineBytes);
appendChunk(echoOutputBytes);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After newline + echo output — row 0 unchanged; row 1 holds `안녕하세요!` output (all wide cells); cursor on row 2.',
  expected: {
    cursor: { row: 2, col: 0 },
    selected_rows: {
      0: {
        text: `${PROMPT}${HANGUL.join('')}${BANG}`,
        widths: widthsPrefix(
          1, 1, 1, 1, 1, 1, 1,
          2, 0, 2, 0, 2, 0, 2, 0, 2, 0,
          1,
        ),
      },
      1: {
        text: `${HANGUL.join('')}${BANG}`,
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
        'Korean 2-set IME post-commit render: `$ echo 안녕하세요!` lands on row 0 with width-2 leading + width-0 continuation per hangul; cursor advances by 2 per syllable.',
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
