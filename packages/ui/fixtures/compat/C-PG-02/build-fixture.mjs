#!/usr/bin/env node
/**
 * SYNTHETIC C-PG-02 fixture generator — `man git-log`.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream (no live PTY recording
 * yet; `tools/compat-record` still pending per Plan 0005 Epic ε §6).
 *
 * What this fixture adds over C-PG-01 (less /etc/passwd)
 * ------------------------------------------------------
 * C-PG-01 covers the raw less lifecycle with a reverse-video status
 * line. C-PG-02 layers in the `man` / `groff` / `less` pipeline's text
 * styling:
 *
 *   - Bold section headers (SGR 1) on `NAME`, `SYNOPSIS`, etc.
 *   - Reverse-video status line at the bottom (SGR 7) with
 *     `Manual page git-log(1) line 1`.
 *
 * Two row-level `sgrDigest` assertions lock the bold + inverse
 * attributes byte-for-byte, so SGR 1 or SGR 7 being dropped or stomped
 * across rows changes the digest.
 *
 * Scenario
 * --------
 *   1. Main buffer: `$ man git-log\r\n`.
 *   2. DECSET 1049h (less's alt-screen entry).
 *   3. Header row on row 0: `GIT-LOG(1)   Git Manual   GIT-LOG(1)` (plain).
 *   4. `NAME` on row 2 in SGR 1 bold.
 *   5. Description on row 3: `       git-log - Show commit logs`.
 *   6. `SYNOPSIS` on row 5 in SGR 1 bold.
 *   7. Synopsis line on row 6: `       git log [<options>] ...`.
 *   8. Status line on row ROWS-1 in SGR 7 inverse.
 *   9. User types `q`, DECSET 1049l.
 *  10. Post-exit shell prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-PG-02/build-fixture.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
// 60 cols × 10 rows leaves room for the header row's centered content
// and keeps the status label fully visible.
const COLS = 60;
const ROWS = 10;
const STATUS_ROW_0IDX = ROWS - 1;
const STATUS_ROW_1IDX = ROWS;

const HEADER_LABEL_LEFT = 'GIT-LOG(1)';
const HEADER_LABEL_MID = 'Git Manual';
const HEADER_LABEL_RIGHT = 'GIT-LOG(1)';

// Compose the header with rough man-style centering. We pick explicit
// column positions so the row is deterministic:
//   col 0..9:   `GIT-LOG(1)`  (10 chars)
//   cols 10..N: spaces until mid label starts
//   mid label at a column such that the whole row is ~symmetric.
//   right label flush to col COLS - len(right).
function composeHeaderRow() {
  const leftCol = 0;
  const rightCol = COLS - HEADER_LABEL_RIGHT.length; // 60-10 = 50
  const midCol = Math.floor((COLS - HEADER_LABEL_MID.length) / 2); // (60-10)/2 = 25
  const row = Array(COLS).fill(' ');
  for (let i = 0; i < HEADER_LABEL_LEFT.length; i += 1) {
    row[leftCol + i] = HEADER_LABEL_LEFT[i];
  }
  for (let i = 0; i < HEADER_LABEL_MID.length; i += 1) {
    row[midCol + i] = HEADER_LABEL_MID[i];
  }
  for (let i = 0; i < HEADER_LABEL_RIGHT.length; i += 1) {
    row[rightCol + i] = HEADER_LABEL_RIGHT[i];
  }
  return row.join('');
}
const HEADER_ROW_TEXT = composeHeaderRow();

const STATUS_LABEL = 'Manual page git-log(1) line 1';

// ---------- Paint helpers ----------
function paintAt(row1, col1, text) {
  return bytes(...CSI, `${row1};${col1}H`, text);
}

function paintBoldAt(row1, col1, text) {
  return bytes(
    ...CSI,
    `${row1};${col1}H`,
    ...CSI,
    '1m',
    text,
    ...CSI,
    '0m',
  );
}

function paintInverseAt(row1, col1, text) {
  return bytes(
    ...CSI,
    `${row1};${col1}H`,
    ...CSI,
    '7m',
    text,
    ...CSI,
    '0m',
  );
}

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

// --- Phase 1: main prompt + command ---
appendChunk(bytes('$ man git-log\r\n'));

// --- Phase 2: enter alt + clear + home ---
appendChunk(bytes(...CSI, '?1049h'));
appendChunk(bytes(...CSI, '2J'));
appendChunk(bytes(...CSI, 'H'));

// --- CP 1: alt entered, cursor home ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049h + CSI 2J + CSI H — alt buffer active, grid cleared, cursor at origin.',
  expected: {
    cursor: { row: 0, col: 0 },
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- Phase 3: header row on row 0 (plain text) ---
appendChunk(paintAt(1, 1, HEADER_ROW_TEXT));

// --- Phase 4: `NAME` section header on row 2, bold ---
appendChunk(paintBoldAt(3, 1, 'NAME'));

// --- Phase 5: description on row 3 ---
appendChunk(paintAt(4, 1, '       git-log - Show commit logs'));

// --- Phase 6: `SYNOPSIS` section header on row 5, bold ---
appendChunk(paintBoldAt(6, 1, 'SYNOPSIS'));

// --- Phase 7: synopsis text on row 6 ---
appendChunk(paintAt(7, 1, '       git log [<options>] ...'));

// --- CP 2: header row — plain, full row text deterministic ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After man header + NAME + SYNOPSIS paint — header row 0 holds the deterministic `GIT-LOG(1) ... Git Manual ... GIT-LOG(1)` composition (no SGR).',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: {
        text: HEADER_ROW_TEXT,
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- CP 3: NAME bold assertion (row 2) ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'NAME section header on row 2 carries SGR 1 bold — sgrDigest locks the bold flag on the four `NAME` cells.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      2: {
        text: 'NAME',
        widths: Array(COLS).fill(1),
        sgrDigest: computeBoldRowDigest('NAME'),
      },
      5: {
        text: 'SYNOPSIS',
        widths: Array(COLS).fill(1),
        sgrDigest: computeBoldRowDigest('SYNOPSIS'),
      },
    },
  },
});

// --- Phase 8: status line (reverse video) on last row ---
appendChunk(paintInverseAt(STATUS_ROW_1IDX, 1, STATUS_LABEL));

// --- CP 4: status line with SGR 7 on cols 0..STATUS_LABEL.length-1 ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After status-line paint — row ROWS-1 reads `Manual page git-log(1) line 1`, cells carry SGR 7 inverse (sgrDigest).',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      [STATUS_ROW_0IDX]: {
        text: STATUS_LABEL,
        widths: Array(COLS).fill(1),
        sgrDigest: computeInverseRowDigest(STATUS_LABEL),
      },
    },
  },
});

// --- Phase 9: `q` → DECSET 1049l — exit alt, main buffer restores ---
appendChunk(bytes(...CSI, '?1049l'));

// --- CP 5: main restored — `$ man git-log` on row 0, cursor back at row 1 col 0 ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l — main buffer restored, alt content discarded. `$ man git-log` still on row 0; cursor back at pre-1049h position.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ man git-log',
        widths: Array(COLS).fill(1),
      },
      1: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- Phase 10: post-exit prompt ---
appendChunk(bytes('$ '));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After post-exit `$ ` prompt — cursor at row 1 col 2, main buffer shows the new prompt.',
  expected: {
    cursor: { row: 1, col: 2 },
    mode: { altScreen: false },
    selected_rows: {
      1: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// ---------- SGR digest helpers (mirror compat-replay.ts:sgrTupleFor) ----------
function cellTuple({ fg = 'd', bg = 'd', flags = 0 } = {}) {
  return `${fg},${bg},${flags}`;
}

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** Bold row: first `label.length` cells have flags bit 0 (bold = 0x01). */
function computeBoldRowDigest(label) {
  const parts = [];
  for (let c = 0; c < COLS; c += 1) {
    if (c < label.length) {
      parts.push(cellTuple({ flags: 0x01 }));
    } else {
      parts.push(cellTuple());
    }
  }
  return sha256Hex(parts.join('|'));
}

/** Inverse row: first `label.length` cells have flags bit 3 (inverse = 0x08). */
function computeInverseRowDigest(label) {
  const parts = [];
  for (let c = 0; c < COLS; c += 1) {
    if (c < label.length) {
      parts.push(cellTuple({ flags: 0x08 }));
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
      shell: 'synthetic-bash-like',
      cols: COLS,
      rows: ROWS,
      description:
        'man git-log: DECSET 1049h + plain header row + bold NAME / SYNOPSIS section headers (SGR 1) + reverse-video status line (SGR 7) + clean 1049l exit. sgrDigest on the bold and inverse rows locks the attribute bits byte-for-byte.',
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
