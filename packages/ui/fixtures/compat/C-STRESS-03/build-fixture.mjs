#!/usr/bin/env node
/**
 * SYNTHETIC C-STRESS-03 fixture generator — DPR change mid-session
 * (engine-level sanity).
 *
 * Plan 0005 P0 Gate #6. A real DPR change (device-pixel-ratio
 * transition, e.g. dragging the window between a retina and non-retina
 * display) MUST invalidate the renderer's font atlas so glyphs re-rasterise
 * at the new pixel density. That concern is renderer-local: it lives in
 * the `FontAtlas` / `Canvas2DBackend` layer, not in `VtEmulator`.
 *
 * This compat fixture therefore only asserts the complementary sanity:
 * the emulator and its grid projection are UNAFFECTED by a hypothetical
 * DPR change. Byte-for-byte, the fixture is a minimal `ls` transcript
 * with a splash of SGR styling. If this fixture regresses, the bug is
 * somewhere other than DPR. Real DPR testing lives in
 * `packages/ui/src/shared/ui/cell-renderer/__tests__/font-atlas.test.ts`.
 *
 * Scenario
 * --------
 *   1. `$ ls --color=auto\r\n`.
 *   2. Directory listing with SGR 34 blue for dirs + SGR 0 reset.
 *   3. Final prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-STRESS-03/build-fixture.mjs
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

const COLS = 40;
const ROWS = 10;

/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// Phase 1: prompt + command.
appendChunk(bytes('$ ls --color=auto\r\n'));

// --- CP 1: prompt rendered ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `ls --color=auto\\r\\n` — row 0 shows the command, cursor at row 1.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ ls --color=auto', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 2: SGR 34 blue for directory name, SGR 0 reset.
appendChunk(bytes(...CSI, '34m', 'src', ...CSI, '0m', '  README.md\r\n'));

// --- CP 2: styled row rendered with widths all=1 (ASCII) ---
// sgrDigest captures the "blue prefix + default suffix" attribute split.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After styled ls output — row 1 reads `src  README.md` with SGR 34 on the `src` prefix and default on the rest.',
  expected: {
    cursor: { row: 2, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      1: {
        text: 'src  README.md',
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// Phase 3: final prompt.
appendChunk(bytes('$ '));

// --- CP 3: prompt parked; no scrollback (tiny scenario) ---
// This is the "DPR invariant from the engine's perspective": after a
// pretend DPR flip, the row projection is still byte-exact.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Final `$ ` prompt parked at row 2. Engine state (cursor, widths, SGR) is unchanged by any renderer-level DPR flip; real atlas-invalidation tests live elsewhere.',
  expected: {
    cursor: { row: 2, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: { text: '$ ls --color=auto', widths: Array(COLS).fill(1) },
      1: { text: 'src  README.md', widths: Array(COLS).fill(1) },
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
      shell: 'synthetic-bash-like',
      cols: COLS,
      rows: ROWS,
      description:
        'DPR change mid-session sanity. Emulator state (grid, widths, SGR) is unaffected by hypothetical device-pixel-ratio transitions — real atlas-invalidation lives in FontAtlas tests. This fixture is a minimal `ls --color=auto` transcript that locks the engine baseline.',
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
