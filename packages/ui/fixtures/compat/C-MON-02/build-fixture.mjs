#!/usr/bin/env node
/**
 * SYNTHETIC C-MON-02 fixture generator — `htop` session with alt-screen exit.
 *
 * Plan 0005 P0 Gate #6. Like C-MON-01 (top) but tests more elaborate
 * coloring: htop paints CPU bars in bg colours (green used, yellow
 * user), process state column coloured per state (R green, S default,
 * Z red), and a footer row of function-key hints. Scrollback ring stays
 * empty across 3 repaint frames.
 *
 * Scenario
 * --------
 *   1. Shell prompt `$ htop\r\n` (main buffer).
 *   2. DECSET 1049h + CSI 2J + CSI H — enter alt, clear, home.
 *   3. Frame 1 — full paint:
 *        row 0: CPU header with coloured bars (SGR 42/43 bg segments).
 *        row 1: Memory row with bar.
 *        row 2: Task count row.
 *        row 3: Column header (PID USER VIRT RES S %CPU %MEM TIME+ CMD).
 *        rows 4..8: process list (5 rows, state column coloured).
 *        row ROWS-1: function-key footer `F1 Help F2 Setup ... F10 Quit`.
 *   4. Frame 2 — cursor home + same rows with slightly different %CPU.
 *   5. Frame 3 — same again.
 *   6. `q` key → DECSET 1049l (exits alt).
 *   7. Shell reprints `$ `.
 *
 * Load-bearing invariants
 * -----------------------
 *   - Alt enter/exit round-trips (CP 1, CP 6).
 *   - Row 0 CPU bar has `sgrDigest` capturing the coloured cells (CP 2).
 *   - Process list rows carry per-row state-column digest (CP 3).
 *   - Footer row at ROWS-1 has the function-key hints (CP 4).
 *   - `scrollback.rowCount === 0` after all 3 repaints (CP 5).
 *   - After 1049l, main buffer restored (CP 6).
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-MON-02/build-fixture.mjs
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
// 80 cols gives enough room for htop's column header and process rows;
// 12 rows is enough for 3 header rows, column header, 5 processes, 2
// blank, and a footer row.
const COLS = 80;
const ROWS = 12;
const FOOTER_ROW = ROWS - 1;

// ---------- Coloured-row emitters ----------
// htop's CPU header looks like:
//   `  1 [||||||||||                        12.3%]`
// where the `||` prefix is painted with bg-green (SGR 42) for "used"
// and a few are bg-yellow (SGR 43) for "user" mode. We keep the number
// of coloured cells FIXED across frames so sgrDigest is stable.
const CPU_LABEL = '  1 [';              // 5 cells default
const CPU_BAR_GREEN = '||||||||';       // 8 cells bg-green
const CPU_BAR_YELLOW = '|||';           // 3 cells bg-yellow
const CPU_BAR_DIM = '                        '; // padding to keep % pos
const CPU_PCT = '12.3%]';

/** Paint the CPU header row with coloured bars. Returns bytes. */
function paintCpuHeaderRow() {
  // Move to (1,1), write label, then SGR 42 + bar, SGR 43 + user, SGR 0
  // + rest.
  return bytes(
    ...CSI, '1;1H',
    CPU_LABEL,
    ...CSI, '42m', CPU_BAR_GREEN,
    ...CSI, '43m', CPU_BAR_YELLOW,
    ...CSI, '0m', CPU_BAR_DIM, CPU_PCT,
  );
}

// Memory row — simpler, single bg-green bar.
const MEM_LABEL = '  Mem[';
const MEM_BAR_GREEN = '|||||||||||||';
const MEM_BAR_DIM = '                          ';
const MEM_PCT = '4.2G/16.0G]';

function paintMemRow() {
  return bytes(
    ...CSI, '2;1H',
    MEM_LABEL,
    ...CSI, '42m', MEM_BAR_GREEN,
    ...CSI, '0m', MEM_BAR_DIM, MEM_PCT,
  );
}

// Task count row (no colour).
const TASK_ROW =
  '  Tasks: 128 total,   1 running, 127 sleeping    Load average: 0.42';

function paintTaskRow() {
  return bytes(...CSI, '3;1H', TASK_ROW.slice(0, COLS));
}

// Column-header row — htop shows this in reverse video (SGR 7).
const COL_HEADER =
  '    PID USER      VIRT    RES   S  %CPU  %MEM     TIME+  Command';

function paintColHeaderRow() {
  return bytes(
    ...CSI, '4;1H',
    ...CSI, '7m', COL_HEADER.slice(0, COLS).padEnd(COLS, ' '),
    ...CSI, '0m',
  );
}

// Process list: 5 rows. Each row has a state column coloured per
// state: R = green (SGR 32), S = default, Z = red (SGR 31).
// We keep the state assignment STABLE across frames (same processes
// in same state) so sgrDigest on the process rows stays invariant
// even though %CPU nudges.
/** @type {Array<{pid:number,user:string,virt:string,res:string,state:'R'|'S'|'Z',cpu:number,mem:number,time:string,cmd:string}>} */
const PROC_LIST = [
  { pid: 1234, user: 'songmin', virt: '2.4G', res: '123M', state: 'S', cpu: 3.8, mem: 2.1, time: '0:12.34', cmd: 'node' },
  { pid: 2100, user: 'songmin', virt: '1.1G', res: '456M', state: 'R', cpu: 6.3, mem: 4.1, time: '0:45.12', cmd: 'vitest' },
  { pid: 456,  user: 'www-data', virt: '256M', res: '78M',  state: 'S', cpu: 1.2, mem: 0.4, time: '2:03.45', cmd: 'nginx' },
  { pid: 9999, user: 'nobody',   virt: '128M', res: '5M',   state: 'Z', cpu: 0.0, mem: 0.0, time: '0:00.01', cmd: 'orphan' },
  { pid: 789,  user: 'postgres', virt: '4.8G', res: '1.8G', state: 'S', cpu: 2.5, mem: 1.8, time: '1:34.56', cmd: 'postgres' },
];

/** State colour per process. */
function stateSgr(state) {
  if (state === 'R') return '32m'; // green
  if (state === 'Z') return '31m'; // red
  return '0m';                     // default
}

/** Build a process row with a coloured state column.
 *  We paint: leading non-state cells (default), state cell coloured,
 *  trailing non-state cells (default). */
function paintProcRow(rowIdx1, p, cpuNudge) {
  const cpuStr = (p.cpu + cpuNudge).toFixed(1).padStart(5, ' ');
  const memStr = p.mem.toFixed(1).padStart(5, ' ');
  // Layout:
  //   "{pid:>7} {user:<9} {virt:>6} {res:>6} {state:1} {cpu:>5} {mem:>5} {time:>8} {cmd}"
  const prefix = `${String(p.pid).padStart(7, ' ')} ${p.user.padEnd(9, ' ')} ${p.virt.padStart(6, ' ')} ${p.res.padStart(6, ' ')} `;
  const suffix = ` ${cpuStr} ${memStr} ${p.time.padStart(8, ' ')} ${p.cmd}`;
  const line = (prefix + p.state + suffix).slice(0, COLS);
  // Locate the state column index within the full line.
  const stateCol = prefix.length; // 0-indexed into the row text
  // Emit:
  //   CSI <row>;1H prefix
  //   CSI <stateSgr> <state>
  //   CSI 0m suffix
  // We segment the line so the state cell is the only coloured one.
  const beforeState = line.slice(0, stateCol);
  const stateChar = line.slice(stateCol, stateCol + 1);
  const afterState = line.slice(stateCol + 1);
  return bytes(
    ...CSI, `${rowIdx1};1H`,
    beforeState,
    ...CSI, stateSgr(p.state),
    stateChar,
    ...CSI, '0m',
    afterState,
  );
}

// Footer row: `F1Help F2Setup F3Search F4Filter F5Tree F6SortBy F7Nice- F8Nice+ F9Kill F10Quit`
const FOOTER =
  'F1Help F2Setup F3Search F4Filter F5Tree F6SortBy F7Nice- F8Nice+ F9Kill F10Quit';

function paintFooterRow() {
  return bytes(
    ...CSI, `${FOOTER_ROW + 1};1H`,
    FOOTER.slice(0, COLS),
  );
}

// ---------- Full-frame paint ----------
/** @param {number} cpuNudge applied to every proc's CPU uniformly */
function paintFrame(cpuNudge) {
  const out = [];
  out.push(...paintCpuHeaderRow());
  out.push(...paintMemRow());
  out.push(...paintTaskRow());
  out.push(...paintColHeaderRow());
  for (let i = 0; i < PROC_LIST.length; i += 1) {
    // Process list starts at row 5 (1-indexed).
    out.push(...paintProcRow(5 + i, PROC_LIST[i], cpuNudge));
  }
  // Rows 10 (blank), and row 11 (0-indexed FOOTER_ROW): footer.
  out.push(...paintFooterRow());
  return out;
}

// Home cursor (used between frames).
const cursorHome = bytes(...CSI, 'H');

// ---------- SGR digest helpers (mirror compat-replay.ts) ----------
function cellTuple({ fg = 'd', bg = 'd', flags = 0 } = {}) {
  return `${fg},${bg},${flags}`;
}
function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** Row 0 (CPU header) digest. Colour layout:
 *    cols 0..4   default (label `  1 [`)
 *    cols 5..12  bg named:2 (green)       — 8 cells
 *    cols 13..15 bg named:3 (yellow)      — 3 cells
 *    cols 16..COLS-1 default (padding + pct)
 *  Cell kinds match the emulator's named-colour encoding: SGR 42 →
 *  named background green (index 2), SGR 43 → named background yellow
 *  (index 3). (SGR 40..47 map to named indices 0..7 in the same order
 *  as the foreground ANSI palette.) */
function cpuHeaderDigest() {
  const parts = [];
  for (let c = 0; c < COLS; c += 1) {
    if (c >= 5 && c <= 12) {
      parts.push(cellTuple({ fg: 'd', bg: 'named:2', flags: 0 }));
    } else if (c >= 13 && c <= 15) {
      parts.push(cellTuple({ fg: 'd', bg: 'named:3', flags: 0 }));
    } else {
      parts.push(cellTuple());
    }
  }
  return sha256Hex(parts.join('|'));
}

/** Digest for a process row. The state column is coloured per state. */
function procRowDigest(p) {
  const prefix = `${String(p.pid).padStart(7, ' ')} ${p.user.padEnd(9, ' ')} ${p.virt.padStart(6, ' ')} ${p.res.padStart(6, ' ')} `;
  const stateCol = prefix.length;
  const parts = [];
  for (let c = 0; c < COLS; c += 1) {
    if (c === stateCol) {
      if (p.state === 'R') parts.push(cellTuple({ fg: 'named:2', bg: 'd', flags: 0 }));
      else if (p.state === 'Z') parts.push(cellTuple({ fg: 'named:1', bg: 'd', flags: 0 }));
      else parts.push(cellTuple());
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

// Phase 1: prompt.
appendChunk(bytes('$ htop\r\n'));

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
      [FOOTER_ROW]: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 3: Frame 1.
appendChunk(paintFrame(0));

// --- CP 2: header has green SGR in CPU bar (sgrDigest) ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After frame 1 — row 0 CPU header has green SGR bg (SGR 42) in bar region + yellow (SGR 43) in user region. sgrDigest pins this.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: {
        text: (CPU_LABEL + CPU_BAR_GREEN + CPU_BAR_YELLOW + CPU_BAR_DIM + CPU_PCT).slice(0, COLS),
        widths: Array(COLS).fill(1),
        sgrDigest: cpuHeaderDigest(),
      },
    },
  },
});

// --- CP 3: process list has colored state column (sgrDigest per row) ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After frame 1 — process list rows 4..8 each carry a state column coloured per state (R green, S default, Z red). sgrDigest per row pins the classification.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      // Process rows are 0-indexed rows 4..8 (we painted at 1-indexed 5..9).
      4: {
        text: procRowText(PROC_LIST[0], 0),
        widths: Array(COLS).fill(1),
        sgrDigest: procRowDigest(PROC_LIST[0]),
      },
      5: {
        text: procRowText(PROC_LIST[1], 0),
        widths: Array(COLS).fill(1),
        sgrDigest: procRowDigest(PROC_LIST[1]),
      },
      7: {
        // Zombie row — red state column.
        text: procRowText(PROC_LIST[3], 0),
        widths: Array(COLS).fill(1),
        sgrDigest: procRowDigest(PROC_LIST[3]),
      },
    },
  },
});

// --- CP 4: footer keybinding row at last row ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Footer row ROWS-1 carries the function-key hint line (F1Help ... F10Quit).',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      [FOOTER_ROW]: {
        text: FOOTER.slice(0, COLS),
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// Phase 4: Frames 2 + 3 (cursor home + same rows with nudged %CPU).
appendChunk(cursorHome);
appendChunk(paintFrame(0.3));
appendChunk(cursorHome);
appendChunk(paintFrame(-0.2));

// --- CP 5: scrollback.rowCount === 0 after 3 repaints ---
// This is the load-bearing invariant — rapid alt-buffer repaints MUST
// NOT leak into the scrollback ring.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After 3 full htop repaint frames — still in alt buffer; scrollback ring has ZERO rows (alt repaints never leak).',
  expected: {
    mode: { altScreen: true },
    scrollback: { rowCount: 0 },
    selected_rows: {
      [FOOTER_ROW]: {
        text: FOOTER.slice(0, COLS),
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// Phase 5: `q` keypress (we just add a comment byte — the emulator
// never sees user input here, only the host-shell-echo response:
// DECSET 1049l).
appendChunk(bytes(...CSI, '?1049l'));
appendChunk(bytes('$ '));

// --- CP 6: after 1049l, main restored ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l + post-exit `$ ` — main buffer restored with `$ htop` on row 0; alt content discarded; scrollback still empty.',
  expected: {
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: { text: '$ htop', widths: Array(COLS).fill(1) },
      1: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// ---------- Helpers ----------
/** Rebuild the literal row text for a process row (must match the
 *  grid projection, which joins graphemes). */
function procRowText(p, cpuNudge) {
  const cpuStr = (p.cpu + cpuNudge).toFixed(1).padStart(5, ' ');
  const memStr = p.mem.toFixed(1).padStart(5, ' ');
  const prefix = `${String(p.pid).padStart(7, ' ')} ${p.user.padEnd(9, ' ')} ${p.virt.padStart(6, ' ')} ${p.res.padStart(6, ' ')} `;
  const suffix = ` ${cpuStr} ${memStr} ${p.time.padStart(8, ' ')} ${p.cmd}`;
  return (prefix + p.state + suffix).slice(0, COLS);
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
        'htop session: DECSET 1049h → 3 full-colour repaint frames (CPU bar green/yellow, proc state R/S/Z colour-coded, footer keybindings) → DECSET 1049l → main buffer restored. Scrollback stays empty.',
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
