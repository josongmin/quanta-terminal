#!/usr/bin/env node
/**
 * SYNTHETIC C-IME-04 fixture generator — European dead-key composition.
 *
 * Plan 0005 P0 wave 4 (W). Companion to C-IME-01 (Korean wide CJK) and
 * C-IME-02/03 (JIS / pinyin, still landing). Where C-IME-01 probes the
 * wide-cell render path (width 2 + width-0 continuation), C-IME-04
 * exercises the ORTHOGONAL case: BMP Latin-1 accented characters (`é`,
 * `ä`, etc.) must classify as width-1, NOT width-2.
 *
 * Context
 * -------
 * Host-side dead-key input (e.g. macOS's `'` + `e` → `é`, US-International
 * on Linux/Windows) commits composed syllables as UTF-8. For `é`, the
 * commit byte sequence is `0xC3 0xA9` (2 bytes, 1 grapheme, width 1 per
 * Unicode East-Asian-Width `Na`/`N`). This fixture tests that the
 * emulator's width classifier correctly falls through to the BMP
 * Latin-1 "narrow" branch and does NOT treat the 2-byte UTF-8 encoding
 * as evidence of a wide cell.
 *
 * The dead-key state machine itself (tracking the combining apostrophe,
 * emitting the composed codepoint) is out of scope — it's tested
 * separately under `packages/ui/src/features/input/ime/...`. Here we
 * start from the post-commit byte stream as delivered by the IME layer.
 *
 * Scenario
 * --------
 *   1. Shell prompt `$ echo ` (7 narrow ASCII chars, cursor col 7).
 *   2. Emit the text `café résumé` (3 plain ASCII + `é` + space + `r` +
 *      `é` + `sum` + `é` = 11 graphemes, all width 1). Cursor advances
 *      to col 18.
 *   3. `\r\n` → next row.
 *   4. Shell echoes `café résumé\r\n` → row 1 holds the output.
 *
 * Load-bearing assertion
 * ----------------------
 *   Row 0 widths === all 1s (specifically: 18 ones followed by 22 default
 *   narrow cells). If `é` were ever misclassified as wide, col 11 (first
 *   `é`) would flip to `2` and col 12 to `0`, breaking the widths array
 *   in a diff-friendly way. The `text` assertion uses the grapheme form
 *   `café résumé` — projection rebuilds text from grapheme-per-cell, so
 *   a misclassified é would also drop its continuation cell from text.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-IME-04/build-fixture.mjs
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
const PHRASE = 'café résumé'; // 11 graphemes — all width 1.

/** widths prefix padded with narrow (1) up to COLS. */
function widthsPrefix(...prefix) {
  const out = new Array(COLS).fill(1);
  for (let i = 0; i < prefix.length; i += 1) out[i] = prefix[i];
  return out;
}

// ---------- Byte chunks ----------
const promptBytes = bytes(PROMPT);
const phraseBytes = bytes(PHRASE);
const newlineBytes = bytes('\r\n');
const echoOutputBytes = bytes(`${PHRASE}\r\n`);

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

// --- CP 1: after prompt — row 0 has `$ echo `, cursor at col 7 ---
appendChunk(promptBytes);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `$ echo ` (7 narrow ASCII chars) — cursor at row 0 col 7.',
  expected: {
    cursor: { row: 0, col: 7 },
    selected_rows: {
      0: {
        text: '$ echo ',
        widths: widthsPrefix(),
      },
    },
  },
});

// --- CP 2: after `café résumé` — row 0 text + all-1s widths ---
// This is the load-bearing assertion. `é` (0xC3 0xA9) must render as a
// SINGLE width-1 grapheme, not width-2-plus-continuation. If the
// classifier ever misclassifies BMP Latin-1 accents as wide, this
// checkpoint breaks loudly: widths would gain a `2,0` pair at col 11
// (first `é`), col 16 (second `é`), col 20 (third `é`), and text would
// lose bytes.
appendChunk(phraseBytes);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `café résumé` — all é are width-1 BMP Latin-1 graphemes; row 0 widths are all 1s; cursor at col 18 (7 prompt + 11 phrase).',
  expected: {
    cursor: { row: 0, col: 18 },
    selected_rows: {
      0: {
        text: `${PROMPT}${PHRASE}`,
        widths: widthsPrefix(),
      },
    },
  },
});

// --- CP 3: after `\r\n` + echo output — row 1 holds the echoed phrase ---
appendChunk(newlineBytes);
appendChunk(echoOutputBytes);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After newline + echo — row 1 holds the echoed `café résumé` (same narrow classification); cursor on row 2.',
  expected: {
    cursor: { row: 2, col: 0 },
    selected_rows: {
      0: {
        text: `${PROMPT}${PHRASE}`,
        widths: widthsPrefix(),
      },
      1: {
        text: PHRASE,
        widths: widthsPrefix(),
      },
    },
  },
});

// --- CP 4: free alt-screen tripwire — nothing in this stream touches alt ---
// Same pattern as C-IME-01's CP 6 upgrade (Agent S wave 3 recommendation).
// Keeping the checkpoint separate from the row-3 checkpoint means a mode
// regression doesn't mask as a row-text failure and vice-versa.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Free alt-screen assertion — Latin-1 echo never enters alt buffer; `mode.altScreen` stays false.',
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
      id: 'C-IME-04',
      kind: 'synthetic',
      snapshotFormatVersion: 1,
      shell: 'zsh',
      cols: COLS,
      rows: ROWS,
      description:
        'Dead-key European composition: `$ echo café résumé` — `é` (UTF-8 0xC3 0xA9) must classify as BMP Latin-1 width-1, NOT wide. All row-0 widths are 1s across the phrase.',
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
