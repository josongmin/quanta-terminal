#!/usr/bin/env node
/**
 * SYNTHETIC C-MUX-02 fixture generator — tmux-in-ssh (depth-2 nesting).
 *
 * Plan 0005 P0 Gate #6. Two nested layers:
 *    local bash → ssh to localhost → remote shell → tmux → `exit` → remote
 *    shell exits → local bash.
 *
 * The engine sees a single PTY byte stream that multiplexes both shells.
 * From its POV there's nothing exotic: just one alt-screen cycle (tmux's
 * 1049h/1049l) interleaved with "remote" shell bytes that are byte-
 * identical to local-shell bytes.
 *
 * Load-bearing invariants
 * -----------------------
 *   - Remote login banner visible on the main buffer before tmux enters
 *     alt (CP 1).
 *   - Alt enters on tmux (CP 2).
 *   - Tmux status line + inner prompt visible in alt buffer (CP 3).
 *   - After tmux exit (inner `exit`), 1049l fires and remote prompt is
 *     back in main (CP 4).
 *   - After ssh exit, local bash prompt is back (CP 5).
 *
 * Scenario
 * --------
 *   1. Local prompt `$ ssh localhost\r\n`.
 *   2. Remote banner `Last login: ...\r\n` then `$ `.
 *   3. Remote `tmux new -s demo\r\n`.
 *   4. DECSET 1049h + clear + home.
 *   5. Tmux status line (reverse video) at last row + inner `$ ` prompt
 *      at row 0.
 *   6. `exit\r\n` in inner tmux → DECSET 1049l.
 *   7. Remote prompt `$ ` returns to main buffer (below the tmux command
 *      line).
 *   8. Remote `exit\r\n` → local prompt `$ `.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-MUX-02/build-fixture.mjs
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
const COLS = 60;
const ROWS = 10;
const STATUS_ROW = ROWS - 1;

const STATUS_LABEL = '[demo] 0:zsh*';
const SSH_BANNER = 'Last login: Sat Jan  1 12:34:00 2022 from 127.0.0.1';

/** Move cursor (1-indexed) + write string. */
function paintAt(row1, col1, text) {
  return bytes(...CSI, `${row1};${col1}H`, text);
}

// ---------- SGR digest helpers ----------
function cellTuple({ fg = 'd', bg = 'd', flags = 0 } = {}) {
  return `${fg},${bg},${flags}`;
}
function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}
/** Status row digest: first `STATUS_LABEL.length` cells are inverse (SGR 7 → flags 0x08). */
function statusDigest() {
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

// ---------- Assemble stream + checkpoints ----------
/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

// Phase 1: local `$ ssh localhost\r\n`.
appendChunk(bytes('$ ssh localhost\r\n'));

// Phase 2: remote banner + prompt.
appendChunk(bytes(SSH_BANNER, '\r\n'));
appendChunk(bytes('$ '));

// --- CP 1: remote login banner visible ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After ssh handshake — row 0 has the local ssh command, row 1 holds the remote banner, row 2 holds the remote prompt.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ ssh localhost', widths: Array(COLS).fill(1) },
      1: { text: SSH_BANNER, widths: Array(COLS).fill(1) },
      2: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 3: remote tmux command.
appendChunk(bytes('tmux new -s demo\r\n'));

// Phase 4: tmux enters alt + clear + home.
appendChunk(bytes(...CSI, '?1049h'));
appendChunk(bytes(...CSI, '2J'));
appendChunk(bytes(...CSI, 'H'));

// --- CP 2: alt enter on tmux ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049h (tmux enters alt) + clear + home — alt buffer active; grid cleared; scrollback still zero (no main-buffer evictions).',
  expected: {
    cursor: { row: 0, col: 0 },
    mode: { altScreen: true },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: { text: '', widths: Array(COLS).fill(1) },
      [STATUS_ROW]: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 5: paint inner prompt at row 0 + status bar at last row.
appendChunk(paintAt(1, 1, '$ '));
appendChunk(bytes(
  ...CSI, `${STATUS_ROW + 1};1H`,
  ...CSI, '7m', STATUS_LABEL,
  ...CSI, '0m',
));

// --- CP 3: tmux status line + inner prompt visible ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Tmux painted: inner `$ ` prompt at row 0 inside alt; status line at row STATUS_ROW with SGR 7 inverse (sgrDigest pins the colouring).',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '$ ', widths: Array(COLS).fill(1) },
      [STATUS_ROW]: {
        text: STATUS_LABEL,
        widths: Array(COLS).fill(1),
        sgrDigest: statusDigest(),
      },
    },
  },
});

// Phase 6: inner `exit\r\n` → tmux sees SIGHUP on its pty → 1049l.
appendChunk(bytes(...CSI, '?1049l'));

// Phase 7: remote shell reprints its prompt.
appendChunk(bytes('$ '));

// --- CP 4: after tmux exit, 1049l, remote prompt back ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l (tmux exits) + remote shell reprints `$ ` — main buffer restored; row 3 holds the remote prompt after the `tmux new` command.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ ssh localhost', widths: Array(COLS).fill(1) },
      1: { text: SSH_BANNER, widths: Array(COLS).fill(1) },
      2: { text: '$ tmux new -s demo', widths: Array(COLS).fill(1) },
      3: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 8: remote `exit\r\n` → back to local.
appendChunk(bytes('exit\r\n'));
// Local shell reprints.
appendChunk(bytes('$ '));

// --- CP 5: after ssh exit, local prompt ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After remote `exit` + local shell reprint — main buffer now shows the local prompt at row 4 (below the `exit` line on row 3).',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      3: { text: '$ exit', widths: Array(COLS).fill(1) },
      4: { text: '$ ', widths: Array(COLS).fill(1) },
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
        'tmux-in-ssh: local bash + ssh to localhost + remote shell + tmux, then unwind. Tests a single alt-screen cycle (tmux) inside an ssh session; engine sees one flattened PTY byte stream, so nothing is exotic.',
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
