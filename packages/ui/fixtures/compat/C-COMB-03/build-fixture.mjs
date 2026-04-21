#!/usr/bin/env node
/**
 * SYNTHETIC C-COMB-03 fixture generator — `yes | head -c 1G` (lightweight).
 *
 * Plan 0005 P0 Gate #6. Lighter version of the `yes | head -c 1G` stress
 * scenario: 50 000 `y\r\n` pairs instead of a gigabyte. Enough to
 * overflow the 10 000-row scrollback cap by 40 000+, so we can assert
 * BOTH `rowCount === 10_000` AND that the eviction path actually ran
 * (we enforce the cap implicitly — if rowCount were > 10 000 or the
 * ring were unbounded, the assertion fails).
 *
 * Note on droppedBytes: the compat harness is sized for tens of KB per
 * fixture, not hundreds. 50 000 × 3 bytes = 150 KB — well inside the
 * emulator's soft / hard caps, so `droppedBytes` stays 0 (confirmed by
 * the harness-audit global invariant).
 *
 * Scenario
 * --------
 *   1. Prompt `$ yes | head -c 1G\r\n`.
 *   2. 50 000 × `y\r\n`.
 *   3. Final prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-COMB-03/build-fixture.mjs
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

const COLS = 40;
const ROWS = 12;
const LINE_COUNT = 50_000;
const SCROLLBACK_CAP = 10_000;

/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// Phase 1: prompt + command.
appendChunk(bytes('$ yes | head -c 1G\r\n'));

// Phase 2: 50_000 × `y\r\n`.
// Build the repeating payload in one flat buffer so we're not generating
// hundreds of thousands of small arrays.
const yLine = 'y\r\n';
const yPayload = yLine.repeat(LINE_COUNT);
appendChunk(bytes(yPayload));

// --- CP 1: scrollback at cap (ring enforced) ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After 50 000 × `y\\r\\n` — scrollback ring sits at its 10 000-row cap (eviction enforced; ring never grows past capacity).',
  expected: {
    mode: { altScreen: false },
    scrollback: { rowCount: SCROLLBACK_CAP },
  },
});

// Phase 3: final prompt.
appendChunk(bytes('$ '));

// --- CP 2: final prompt + cap still enforced ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After final `$ ` — scrollback still at cap; altScreen still false. Even with 5× more content than ring capacity, the cap holds.',
  expected: {
    cursor: { row: 11, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: SCROLLBACK_CAP },
    selected_rows: {
      11: { text: '$ ', widths: Array(COLS).fill(1) },
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
        '`yes | head -c 1G` lightweight (50 000 × `y\\r\\n`): exercises the scrollback-ring cap under 5× overflow. rowCount pinned at 10 000; droppedBytes is still 0 (enforced by harness-audit globally).',
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
