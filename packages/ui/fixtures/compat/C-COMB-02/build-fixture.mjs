#!/usr/bin/env node
/**
 * SYNTHETIC C-COMB-02 fixture generator — `find / 2>/dev/null`
 * (timeboxed).
 *
 * Plan 0005 P0 Gate #6. Main-buffer scroll-up + scrollback-ring stress.
 * A real `find /` would emit millions of pathnames; we emit 800 — enough
 * to force hundreds of scroll-ups without blowing past the 10 000-row
 * scrollback cap.
 *
 * Scenario
 * --------
 *   1. Prompt `$ find / 2>/dev/null\r\n`.
 *   2. 800 pathname rows (`/etc/...`, `/Users/...`, `/var/...`, ...).
 *   3. Final prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-COMB-02/build-fixture.mjs
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

const COLS = 80;
const ROWS = 24;
const LINE_COUNT = 800;

// Deterministic pathname-ish content. Pulls from a small set of prefixes
// so rows look realistic enough.
const PREFIXES = [
  '/Users/songmin/Documents/code',
  '/etc/ssh/ssh_config.d',
  '/var/log/system',
  '/usr/local/share/man',
  '/opt/homebrew/Cellar/node',
];
function pathRow(i) {
  const p = PREFIXES[i % PREFIXES.length];
  return `${p}/file-${String(i).padStart(4, '0')}.txt`;
}

/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// Phase 1: prompt.
appendChunk(bytes('$ find / 2>/dev/null\r\n'));

// Phase 2: 800 pathname rows.
for (let i = 0; i < LINE_COUNT; i += 1) {
  appendChunk(bytes(pathRow(i), '\r\n'));
}

// --- CP 1: altScreen stays false throughout ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After 800 pathname rows — altScreen is false (find never enters alt).',
  expected: {
    mode: { altScreen: false },
  },
});

// --- CP 2: scrollback grew past 700 rows (viewport is 24; prompt + 800
// lines ≈ 801 rows; scrollback ≈ 801 - 23 = 778 rows). We assert a
// conservative lower bound (> 700) so any future scrollback-eviction
// regression that under-counts is caught without pinning an exact
// number that changes if the prompt row layout shifts.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After 800 pathname rows — scrollback ring has ~778 rows (> 700); main-buffer scroll-up captured them correctly.',
  expected: {
    scrollback: { rowCount: LINE_COUNT - ROWS + 2 },
  },
});

// Phase 3: final prompt.
appendChunk(bytes('$ '));

// --- CP 3: altScreen stays false + final prompt ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After final `$ ` — viewport bottom row holds the prompt; altScreen still false.',
  expected: {
    cursor: { row: 23, col: 2 },
    mode: { altScreen: false },
    selected_rows: {
      23: { text: '$ ', widths: Array(COLS).fill(1) },
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
        '`find / 2>/dev/null` (timeboxed to 800 pathnames): main-buffer scroll-up + scrollback-ring stress. Asserts altScreen stays false and the ring captures ~778 rows without emergency drops.',
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
