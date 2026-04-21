#!/usr/bin/env node
/**
 * SYNTHETIC C-SH-03 fixture generator — fish autosuggest ghost text.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream (no live PTY recording
 * yet; `tools/compat-record` pending per Plan 0005 Epic ε §6).
 *
 * What this fixture asserts
 * -------------------------
 * Fish displays its inline autosuggestion in dim/bright-black foreground
 * (SGR 90 by default) and pulls the cursor BACK to the end of the
 * actually-typed portion with `CSI n D` so the next printable overwrites
 * the ghost. When the user accepts with Right-arrow, fish would rewrite
 * the span with default SGR — this fixture stops at the "ghost is
 * displayed, cursor parked" state.
 *
 * The load-bearing assertion is a row-level `sgrDigest` on row 0: the
 * typed prefix (`$ ls `) uses default fg, the ghost tail (`/tmp`) uses
 * SGR fg=bright:0. If the engine drops SGR 90 or misapplies it across
 * the cursor-back boundary, the digest changes.
 *
 * Scenario
 * --------
 *   1. `$ ` prompt printed (main buffer, row 0).
 *   2. User types `ls ` — three cells echoed.
 *   3. Fish paints autosuggestion: `CSI 90 m`, `/tmp`, `CSI 0 m`.
 *   4. `CSI 4 D` moves cursor back 4 cols so the next keystroke lands
 *      where `/tmp` starts (overwriting the ghost).
 *
 * Row 0 visible text after all bytes: `$ ls /tmp` (9 cells). Cursor
 * parks at col 5 (just after `$ ls `). Cols 0..4 default SGR; cols
 * 5..8 carry fg=bright:0.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-SH-03/build-fixture.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ESC = 0x1b;
const CSI = [ESC, 0x5b]; // ESC [
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
// Small viewport — the scenario uses only row 0, so 6 rows is plenty.
const COLS = 40;
const ROWS = 6;

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

// --- Phase 1: prompt `$ ` written on row 0 ---
appendChunk(bytes('$ '));

// --- Phase 2: user types `ls ` (three cells echoed) ---
appendChunk(bytes('ls '));

// --- Phase 3: fish autosuggest paint ---
//   CSI 90 m   — set fg to bright black (index 0)
//   "/tmp"     — four cells, all carrying the bright-black fg
//   CSI 0 m    — reset SGR to default (so the cursor-back doesn't leak
//                style to future writes)
appendChunk(bytes(...CSI, '90m'));
appendChunk(bytes('/tmp'));
appendChunk(bytes(...CSI, '0m'));

// --- Phase 4: cursor-back 4 cols ---
// After the ghost, cursor is at col 9; `CSI 4 D` pulls it back to col 5,
// i.e. immediately after `$ ls `.
appendChunk(bytes(...CSI, '4D'));

// --- CP 1: row 0 text + sgrDigest asserts ghost-text SGR ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After fish autosuggest paint — row 0 reads `$ ls /tmp`, cols 5..8 carry SGR fg=bright:0 (bright-black ghost text). sgrDigest is load-bearing.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ ls /tmp',
        widths: Array(COLS).fill(1),
        sgrDigest: computeGhostDigest(),
      },
    },
  },
});

// --- CP 2: cursor parked at col 5 after the 4D cursor-back ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `CSI 4 D` cursor-back — cursor at row 0 col 5 (immediately after `$ ls `), ready to overwrite the ghost on the next keystroke.',
  expected: {
    cursor: { row: 0, col: 5 },
    mode: { altScreen: false },
  },
});

// ---------- SGR digest helper (mirrors compat-replay.ts) ----------
function cellTuple({ fg = 'd', bg = 'd', flags = 0 } = {}) {
  return `${fg},${bg},${flags}`;
}

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Row 0 after the ghost-text paint:
 *   col 0: `$`  — default fg, default bg, no flags
 *   col 1: ` `  — default (but was printed, so has grapheme=' ')
 *   col 2: `l`  — default
 *   col 3: `s`  — default
 *   col 4: ` `  — default
 *   col 5: `/`  — fg=bright:0
 *   col 6: `t`  — fg=bright:0
 *   col 7: `m`  — fg=bright:0
 *   col 8: `p`  — fg=bright:0
 *   cols 9..COLS-1: never written → cell.fg = 'default' (blank cells).
 *
 * Note: `projectRow` calls `sgrTupleFor(cell)` for EVERY column. Cells
 * that were never written still have default SGR, so they serialize
 * identically to "default" regardless of whether they hold a printable.
 */
function computeGhostDigest() {
  const parts = [];
  for (let c = 0; c < COLS; c += 1) {
    if (c >= 5 && c <= 8) {
      parts.push(cellTuple({ fg: 'bright:0', bg: 'd', flags: 0 }));
    } else {
      parts.push(cellTuple());
    }
  }
  return sha256Hex(parts.join('|'));
}

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
      shell: 'synthetic-fish',
      cols: COLS,
      rows: ROWS,
      description:
        'fish autosuggest ghost text: `$ ls ` typed, autosuggestion `/tmp` painted in SGR 90 (bright-black fg), cursor pulled back 4 cols with CSI 4 D. sgrDigest on row 0 locks the ghost-text fg byte-for-byte.',
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
