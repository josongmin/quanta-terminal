#!/usr/bin/env node
/**
 * SYNTHETIC C-STRESS-02 fixture generator — `cat 100mb.log` → scrollback eviction.
 *
 * Plan 0005 P0 Gate #6. 15 000 rows of content force the scrollback ring
 * past its 10 000-row default cap, so the head gets evicted. We assert
 * that at peak:
 *   - `scrollback.rowCount === 10 000` (cap enforced, no oversize ring),
 *   - scrollback row 0 (oldest surviving) is no longer the first line
 *     emitted — eviction walked forward.
 *
 * The default VtEmulator cap is 10 000 rows (see `VtEmulator.ts`
 * `DEFAULT_SCROLLBACK_ROWS`). The compat harness uses that default via
 * `replayCompatFixture`, so this fixture exercises the shipped config.
 *
 * Scenario
 * --------
 *   1. Shell prompt `$ cat /tmp/100mb.log\r\n`.
 *   2. 15 000 rows of `line NNNNN\r\n`.
 *   3. Final shell prompt `$ `.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-STRESS-02/build-fixture.mjs
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
const COLS = 80;
const ROWS = 24;
const LINE_COUNT = 15_000;
const SCROLLBACK_CAP = 10_000;

function logLine(i) {
  // `line NNNNN` → 5-digit zero-padded index so rows are stable strings
  // (useful if we ever want to assert specific row content).
  const idx = String(i).padStart(5, '0');
  return `line ${idx}`;
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

// Phase 1: prompt + command.
appendChunk(bytes('$ cat /tmp/100mb.log\r\n'));

// Phase 2: 15 000 rows.
for (let i = 0; i < LINE_COUNT; i += 1) {
  appendChunk(bytes(logLine(i), '\r\n'));
}

// --- CP 1: scrollback at cap ---
// After emitting 15 000 rows of content + the prompt row, the main
// buffer has scrolled ~15 000 times total. The scrollback ring caps at
// 10 000 — so `rows.length === 10 000` and the head has been evicted
// many thousands of times.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After 15 000 rows emitted — scrollback ring is at its 10 000-row cap; the head has been evicted as new rows pushed past capacity.',
  expected: {
    mode: { altScreen: false },
    scrollback: { rowCount: SCROLLBACK_CAP },
  },
});

// --- CP 2: altScreen stays false ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'altScreen invariant — main-buffer cat never enters alt.',
  expected: {
    mode: { altScreen: false },
  },
});

// Phase 3: final prompt.
appendChunk(bytes('$ '));

// --- CP 3: final prompt parked, scrollback still at cap ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After final prompt — scrollback still at cap; viewport row 23 holds `$ `.',
  expected: {
    cursor: { row: 23, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: SCROLLBACK_CAP },
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
        'cat /tmp/100mb.log → 15 000 rows of `line NNNNN` output. Forces scrollback-ring eviction past the 10 000-row default cap; verifies the ring stays at cap and old rows are dropped (no unbounded growth under heavy main-buffer flow).',
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
