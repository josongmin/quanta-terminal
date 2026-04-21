#!/usr/bin/env node
/**
 * SYNTHETIC C-MON-03 fixture generator — `watch -n 0.1 date` repaint stress.
 *
 * Plan 0005 P0 Gate #6. Pure repaint-volume test: `watch -n 0.1 date`
 * redraws the entire screen every 100 ms. Real sessions emit dozens of
 * frames before the user C-c's. Our synthetic stream paints 60 frames
 * (~6 simulated seconds) to exercise the rapid-repaint code path.
 *
 * Load-bearing invariants
 * -----------------------
 *   - Top row keeps the watch header across all frames (CP 2).
 *   - `scrollback.rowCount === 0` after 60 repaints — rapid paints
 *     MUST NOT leak into the main-buffer scrollback ring (CP 3).
 *   - After C-c / 1049l, `alt_screen === false` (CP 4).
 *
 * Scenario
 * --------
 *   1. Shell prompt `$ watch -n 0.1 date\r\n`.
 *   2. DECSET 1049h + CSI 2J + CSI H.
 *   3. 60 repaint frames. Each frame:
 *        a. CSI H (home).
 *        b. Write header line at row 0.
 *        c. CSI <mid>;<col>H.
 *        d. Write date at a centred position.
 *      Each frame varies the "seconds" field of the date line so the
 *      stream isn't totally redundant (keeps the emulator's change-
 *      detection honest).
 *   4. DECSET 1049l (C-c handled by watch).
 *   5. Shell prompt `$ `.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-MON-03/build-fixture.mjs
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
const COLS = 80;
const ROWS = 10;
const CENTER_ROW = Math.floor(ROWS / 2);

// Header: watch writes this at the top of the screen (left-aligned
// interval + right-aligned date-of-command) across the full width.
// We keep the header STABLE across all frames.
const HEADER_PREFIX = 'Every 0.1s: date';
const HEADER_TAIL = 'Sat Jan  1 12:34:56 UTC 2022';
function headerLine() {
  const filler = ' '.repeat(Math.max(1, COLS - HEADER_PREFIX.length - HEADER_TAIL.length));
  return (HEADER_PREFIX + filler + HEADER_TAIL).slice(0, COLS);
}
const HEADER = headerLine();

// Centre date — this is the only content that varies across frames.
// Real watch shows the `date` command's output centred-ish; we just
// tweak the seconds field so bytes are non-trivially different per
// frame.
function centreDateLine(frameIdx) {
  const ss = String(frameIdx % 60).padStart(2, '0');
  return `Sat Jan  1 12:34:${ss} UTC 2022`;
}

const FRAME_COUNT = 60;

// ---------- Assemble stream + checkpoints ----------
/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// Phase 1: prompt.
appendChunk(bytes('$ watch -n 0.1 date\r\n'));

// Phase 2: enter alt + clear + home.
appendChunk(bytes(...CSI, '?1049h'));
appendChunk(bytes(...CSI, '2J'));
appendChunk(bytes(...CSI, 'H'));

// --- CP 1: alt enter ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049h + CSI 2J + CSI H — alt buffer active, grid cleared, cursor at origin.',
  expected: {
    cursor: { row: 0, col: 0 },
    mode: { altScreen: true },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 3: paint 10 frames, checkpoint, paint 50 more, checkpoint.
function paintOneFrame(frameIdx) {
  const out = [];
  // Home.
  out.push(...bytes(...CSI, 'H'));
  // Header row 0 (right after home — no need to move).
  out.push(...bytes(HEADER));
  // Move to (CENTER_ROW+1, 1) 1-indexed and paint date.
  // We clear the row first with CSI K (erase-in-line, to end) so stale
  // cells from the prior frame don't tail past the new date; then we
  // just write the date itself (no trailing padding so `projectRow`'s
  // trailing-blank strip gives us the bare date back).
  const date = centreDateLine(frameIdx);
  out.push(
    ...bytes(...CSI, `${CENTER_ROW + 1};1H`, ...CSI, 'K', date),
  );
  return out;
}

// Paint first 10 frames.
for (let f = 0; f < 10; f += 1) {
  appendChunk(paintOneFrame(f));
}

// --- CP 2: after 10 repaints, top row still has the header ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After 10 repaint frames — row 0 still contains the watch header (repainted every frame, never scrolls).',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: {
        text: HEADER,
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// Paint frames 10..59.
for (let f = 10; f < FRAME_COUNT; f += 1) {
  appendChunk(paintOneFrame(f));
}

// --- CP 3: after 60 repaints, scrollback.rowCount === 0 (no leak) ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After 60 repaint frames — still in alt buffer; scrollback ring has ZERO rows. Rapid alt-repaints must never leak into the main-buffer ring.',
  expected: {
    mode: { altScreen: true },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: {
        text: HEADER,
        widths: Array(COLS).fill(1),
      },
      [CENTER_ROW]: {
        text: centreDateLine(FRAME_COUNT - 1),
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// Phase 4: C-c → DECSET 1049l.
appendChunk(bytes(...CSI, '?1049l'));

// Phase 5: shell prompt.
appendChunk(bytes('$ '));

// --- CP 4: after exit, alt === false ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l + post-exit `$ ` — main buffer restored; alt_screen === false; scrollback still empty.',
  expected: {
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: {
        text: '$ watch -n 0.1 date',
        widths: Array(COLS).fill(1),
      },
      1: { text: '$ ', widths: Array(COLS).fill(1) },
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
        'watch -n 0.1 date repaint stress: DECSET 1049h → 60 cursor-home repaint frames (~6 simulated seconds) → C-c / DECSET 1049l. Exercises rapid alt-repaint with zero scrollback leak.',
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
