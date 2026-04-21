#!/usr/bin/env node
/**
 * SYNTHETIC C-MUX-01 fixture generator — `tmux new -s demo` basic flow.
 *
 * Plan 0005 P0 Epic ε. Hand-authored byte stream (no live PTY recording
 * yet; `tools/compat-record` is still pending).
 *
 * What this fixture asserts
 * -------------------------
 * tmux is a terminal multiplexer. From our emulator's POV, tmux is just
 * another application that enters the alt screen, paints panes + a
 * status line, and exits. We DO NOT test tmux's control-sequence
 * passthrough (that's an emulator-internal concern); we test that:
 *
 *   1. tmux's alt-buffer entry + status-line paint round-trip correctly.
 *   2. After `C-b "` (split-horizontal), the screen shows TWO pane
 *      prompts — an upper pane prompt at row 0 and a lower pane prompt
 *      roughly at row N/2. Real tmux redraws the whole visible area; we
 *      synthesise the same visible result by erasing + repainting.
 *   3. The status line carries reverse-video SGR preserved across the
 *      paint — `sgrDigest` on the status row is the load-bearing byte
 *      assertion.
 *   4. `C-b d` (detach) emits DECSET 1049l, restoring the main buffer.
 *
 * Why synthetic?
 * Real tmux emits ~2 KiB of setup (CSI ?2004h bracketed paste, terminfo
 * negotiation, cursor-style queries, etc.) before painting the first
 * pane. None of that is load-bearing for the round-trip. A hand-authored
 * stream keeps the fixture reviewable byte-by-byte.
 *
 * Scenario
 * --------
 *   1. Shell prompt `$ tmux new -s demo\r\n`.
 *   2. DECSET 1049h (tmux enters alt).
 *   3. Paint upper pane: `$ ` prompt at row 0, then `echo hello` run:
 *      row 0 `$ echo hello`, row 1 `hello`, row 2 `$ `.
 *   4. Status line at row ROWS-1 (reverse video): `[demo] 0:zsh*`.
 *   5. Split-horizontal: erase display, repaint upper pane on rows
 *      0..N/2-1 with its prompt, lower pane on rows N/2..ROWS-2 with a
 *      fresh `$ ` prompt, status line on row ROWS-1.
 *   6. DECSET 1049l (detach).
 *   7. Post-exit shell prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-MUX-01/build-fixture.mjs
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
// 40 cols keeps the status label ('[demo] 0:zsh*') fully visible; 10
// rows gives us 4 upper-pane rows + 1 separator + 4 lower-pane rows + 1
// status row, with room to verify the split paint visually.
const COLS = 40;
const ROWS = 10;
// Row index of the status line (last row).
const STATUS_ROW = ROWS - 1;
// Row where the lower pane's prompt will land after split — roughly at
// N/2. With ROWS=10 we put the split at row 5, so the lower prompt lands
// on row 5.
const SPLIT_ROW = Math.floor(ROWS / 2);

const STATUS_LABEL = '[demo] 0:zsh*';

// Phase 1: shell prompt + command.
const phase1 = bytes('$ tmux new -s demo\r\n');

// Phase 2: enter alt.
const enter1049 = bytes(...CSI, '?1049h');
const clearAndHome = bytes(...CSI, '2J', ...CSI, 'H');

/** Move to (row, col) 1-indexed and write string. */
function paintAt(row, col, text) {
  return bytes(...CSI, `${row};${col}H`, text);
}

// Phase 3: upper pane content.
//   Row 0: `$ echo hello`
//   Row 1: `hello`
//   Row 2: `$ `
const upperPaneContent = [
  ...paintAt(1, 1, '$ echo hello'),
  ...paintAt(2, 1, 'hello'),
  ...paintAt(3, 1, '$ '),
];

// Phase 4: status bar (reverse video).
function paintStatus() {
  return bytes(
    ...CSI,
    `${STATUS_ROW + 1};1H`,
    ...CSI,
    '7m',
    STATUS_LABEL,
    ...CSI,
    '0m',
  );
}
const statusBar = paintStatus();

// Phase 5: split-horizontal. Erase everything, repaint both panes +
// status. Upper pane keeps its prompt at row 0; lower pane starts with a
// fresh `$ ` prompt at SPLIT_ROW.
const eraseDisplay = bytes(...CSI, '2J');
const splitPaint = [
  // Upper pane — just the prompt (post-split, the echo history is gone
  // because real tmux re-evaluates pane geometry and this is a fresh
  // pane on top; simulating "blank upper with prompt" is enough).
  ...paintAt(1, 1, '$ '),
  // Lower pane prompt at SPLIT_ROW (0-indexed) → 1-indexed row = SPLIT_ROW+1.
  ...paintAt(SPLIT_ROW + 1, 1, '$ '),
  // Repaint status on the same last row.
  ...paintStatus(),
];

// Phase 6: detach (DECSET 1049l).
const exit1049 = bytes(...CSI, '?1049l');
const postPrompt = bytes('$ ');

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

// --- CP 1: after DECSET 1049h + clear + home ---
appendChunk(phase1);
appendChunk(enter1049);
appendChunk(clearAndHome);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049h + CSI 2J + CSI H — alt buffer active, grid cleared, cursor at origin.',
  expected: {
    cursor: { row: 0, col: 0 },
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '', widths: Array(COLS).fill(1) },
      [STATUS_ROW]: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 2: after upper pane content + status bar — status uses SGR 7 ---
appendChunk(upperPaneContent);
appendChunk(statusBar);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After tmux paints upper pane content + reverse-video status bar — row 0 contains `$ echo hello`, status row carries SGR 7 inverse (byte-for-byte via sgrDigest).',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '$ echo hello', widths: Array(COLS).fill(1) },
      1: { text: 'hello', widths: Array(COLS).fill(1) },
      2: { text: '$ ', widths: Array(COLS).fill(1) },
      [STATUS_ROW]: {
        text: STATUS_LABEL,
        widths: Array(COLS).fill(1),
        sgrDigest: computeStatusDigest(),
      },
    },
  },
});

// --- CP 3: verify prompt row 0 contains `$ ` before split (redundant
// with CP 2 but makes the split diff assertion easier to reason about) ---
// Skipped as a separate CP — we already caught the prompt on CP 2.

// --- CP 3 (renumbered): after split paint — row 0 has upper prompt,
// row SPLIT_ROW has lower prompt ---
appendChunk(eraseDisplay);
appendChunk(splitPaint);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After tmux C-b " split-horizontal paint — row 0 shows upper pane prompt, row SPLIT_ROW shows lower pane prompt, status bar repainted.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '$ ', widths: Array(COLS).fill(1) },
      [SPLIT_ROW]: { text: '$ ', widths: Array(COLS).fill(1) },
      [STATUS_ROW]: {
        text: STATUS_LABEL,
        widths: Array(COLS).fill(1),
        sgrDigest: computeStatusDigest(),
      },
    },
  },
});

// --- CP 4: after DECSET 1049l (detach) — main buffer restored ---
appendChunk(exit1049);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l (tmux detach) — main buffer restored with `$ tmux new -s demo` on row 0; alt content + status discarded.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ tmux new -s demo',
        widths: Array(COLS).fill(1),
      },
      1: { text: '', widths: Array(COLS).fill(1) },
      [STATUS_ROW]: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 5: after post-exit `$ ` prompt ---
appendChunk(postPrompt);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After post-exit `$ ` — cursor at row 1 col 2, main buffer shows the new prompt.',
  expected: {
    cursor: { row: 1, col: 2 },
    mode: { altScreen: false },
    selected_rows: {
      1: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// ---------- SGR digest helper (mirrors compat-replay.ts) ----------
function cellTuple({ fg = 'd', bg = 'd', flags = 0 } = {}) {
  return `${fg},${bg},${flags}`;
}
function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** Status row digest: first `STATUS_LABEL.length` cells are inverse
 *  (flags bit 3 = 0x08), rest are default. */
function computeStatusDigest() {
  const parts = [];
  for (let c = 0; c < COLS; c += 1) {
    if (c < STATUS_LABEL.length) {
      parts.push(cellTuple({ fg: 'd', bg: 'd', flags: 0x08 }));
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
      id: 'C-MUX-01',
      kind: 'synthetic',
      snapshotFormatVersion: 1,
      shell: 'synthetic-bash-like',
      cols: COLS,
      rows: ROWS,
      description:
        'tmux new + split-horizontal + detach: DECSET 1049h → upper pane paint + status bar (SGR 7) → C-b " split paint (two panes visible) → DECSET 1049l → main buffer restored.',
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
