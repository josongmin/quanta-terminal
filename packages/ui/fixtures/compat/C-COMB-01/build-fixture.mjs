#!/usr/bin/env node
/**
 * SYNTHETIC C-COMB-01 fixture generator — `git log | less | head -20`.
 *
 * Plan 0005 P0 Gate #6. Pipe + pager + head chain. `less` enters the
 * alt buffer, paints 20 rows of commit log, then sees EOF from `head`
 * and exits — restoring the main buffer. Classic "single alt-screen
 * cycle with content" case, plus the COMB-specific invariant that the
 * alt-buffer commit content never leaks into the scrollback ring.
 *
 * Scenario
 * --------
 *   1. Prompt `$ git log | less | head -20\r\n`.
 *   2. DECSET 1049h (less enters alt).
 *   3. CSI 2J + CSI H (less clears + homes).
 *   4. 20 rows of `abc1234 2026-04-20 commit subject N` pattern.
 *   5. DECSET 1049l (less exits on EOF).
 *   6. Post-exit prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-COMB-01/build-fixture.mjs
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

// 80 cols × 24 rows — classic git-log-via-less layout.
const COLS = 80;
const ROWS = 24;

function hashFor(i) {
  // 7-hex commit hash lookalike. Deterministic.
  const hex = (i * 0x9e37 + 0xabc1234) >>> 0;
  return hex.toString(16).padStart(7, '0').slice(0, 7);
}

function commitRow(i) {
  const subj = `commit subject ${i}`;
  const line = `${hashFor(i)} 2026-04-20 ${subj}`;
  return line;
}

/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// Phase 1: shell prompt.
appendChunk(bytes('$ git log | less | head -20\r\n'));

// Phase 2: less enters alt + clears + homes.
appendChunk(bytes(...CSI, '?1049h'));
appendChunk(bytes(...CSI, '2J'));
appendChunk(bytes(...CSI, 'H'));

// --- CP 1: alt enter ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049h + CSI 2J + CSI H — less in alt buffer, grid cleared, cursor home.',
  expected: {
    cursor: { row: 0, col: 0 },
    mode: { altScreen: true },
    scrollback: { rowCount: 0 },
  },
});

// Phase 3: paint 20 rows of commits.
for (let i = 0; i < 20; i += 1) {
  appendChunk(bytes(commitRow(i), '\r\n'));
}

// --- CP 2: row 0 has commit-hash-like prefix ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After 20 commit rows painted — row 0 has the first commit (hash prefix visible), rows 1+ hold subsequent commits.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: {
        text: commitRow(0),
        widths: Array(COLS).fill(1),
      },
      10: {
        text: commitRow(10),
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// Phase 4: less exits on EOF — DECSET 1049l.
appendChunk(bytes(...CSI, '?1049l'));

// Phase 5: post-exit prompt.
appendChunk(bytes('$ '));

// --- CP 3: main buffer restored ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l — main buffer restored; row 0 still shows the original shell command (pre-alt content); row 1 shows the post-exit prompt.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ git log | less | head -20',
        widths: Array(COLS).fill(1),
      },
      1: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 4: scrollback never captured the alt content ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Invariant — alt-buffer commit log never leaked into the main-buffer scrollback ring.',
  expected: {
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
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
        '`git log | less | head -20`: pipe + pager + head combinator. less enters alt, paints 20 commit rows, exits on EOF. Asserts alt-buffer content never leaks to scrollback — the foundational pager invariant, repeated for a PIPED less.',
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
