#!/usr/bin/env node
/**
 * SYNTHETIC C-MON-01 fixture generator — `top` 30-second session.
 *
 * Plan 0005 P0 Epic ε. We don't actually need 30 seconds of real top
 * output; three synthetic repaint frames are enough to prove the two
 * invariants under test:
 *
 *   1. Alt-buffer repaints are STRUCTURALLY symmetric: multiple frames
 *      never cause the emulator to drop out of alt and silently re-enter.
 *      (CP 3 asserts `mode.altScreen === true` after frame 3.)
 *
 *   2. Alt-buffer repaints NEVER leak into the main-buffer scrollback
 *      ring. Per Plan 0005 Epic α3, only main-buffer evictions feed the
 *      ring; alt paints are ephemeral. A regression here would break
 *      block-export semantics and memory bounds. (CP 3 asserts
 *      `scrollback.rowCount === 0`.)
 *
 * Scenario
 * --------
 *   1. Shell prompt `$ top\r\n` (main buffer).
 *   2. DECSET 1049h — enter alt (engine clears implicitly).
 *   3. Frame 1: top header + task summary + process list.
 *   4. Frame 2: erase + repaint with updated %CPU values.
 *   5. Frame 3: erase + repaint again.
 *   6. DECSET 1049l — exit alt; main buffer restored.
 *   7. Shell reprints `$ `.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-MON-01/build-fixture.mjs
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
const ROWS = 24;

// Stable header rows (rows 0..4). Real top rewrites these every tick
// with changing uptime/loadavg numbers; we keep them fixed across
// frames so the checkpoint expectation stays reviewable.
const HEADER_ROW_0 = 'top - 21:17:02 up 1 day,  3:45,  2 users,  load average: 0.42, 0.38, 0.30';
const HEADER_ROW_1 = 'Tasks: 128 total,   1 running, 127 sleeping,   0 stopped,   0 zombie';
const HEADER_ROW_2 = '%Cpu(s):  3.2 us,  1.1 sy,  0.0 ni, 95.6 id,  0.0 wa,  0.1 hi,  0.0 si,  0.0 st';
const HEADER_ROW_3 = 'MiB Mem :  16384.0 total,   2048.5 free,   8192.0 used,   6143.5 buff/cache';
const HEADER_ROW_4 = 'MiB Swap:   4096.0 total,   4096.0 free,      0.0 used.   7891.2 avail Mem';

// Column-header row (row 5).
const COL_HEADER =
  '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND';

/** Build a process-list row. CPU varies between frames; the rest is
 *  stable. Left-pads columns so the row renders ~the right width. */
function procRow(pid, user, pr, cpu, mem, cmd) {
  const cpuStr = cpu.toFixed(1).padStart(5, ' ');
  const memStr = mem.toFixed(1).padStart(5, ' ');
  // Real top uses fixed-width columns; we reproduce the structure so
  // tests that want column-exact projections could add them later. Here
  // we only assert on the first row (the header), so the body rows can
  // be lightly approximate.
  return `${String(pid).padStart(7, ' ')} ${user.padEnd(9, ' ')} ${String(pr).padStart(2, ' ')}  0  1234.5m  123.4m   45.6m S ${cpuStr} ${memStr}   0:12.34 ${cmd}`.slice(0, COLS);
}

/** Paint a single frame: rows 0..5 are headers, rows 6..ROWS-1 are
 *  process entries (18 rows). `cpuOffsets` lets the frames differ. */
function frameLines(cpuOffsets) {
  const lines = [
    HEADER_ROW_0,
    HEADER_ROW_1,
    HEADER_ROW_2,
    HEADER_ROW_3,
    HEADER_ROW_4,
    COL_HEADER,
  ];
  const base = [
    [1, 'root', 20, 0.1, 0.3, 'systemd'],
    [123, 'root', 20, 0.0, 0.1, 'kthreadd'],
    [456, 'www-data', 20, 1.2, 0.4, 'nginx'],
    [789, 'postgres', 20, 2.5, 1.8, 'postgres'],
    [1001, 'songmin', 20, 3.8, 2.1, 'node'],
    [1234, 'songmin', 20, 5.1, 3.2, 'code'],
    [1500, 'root', 20, 0.4, 0.2, 'sshd'],
    [1600, 'songmin', 20, 0.2, 0.5, 'bash'],
    [1700, 'songmin', 20, 0.0, 0.1, 'tmux'],
    [1800, 'root', 20, 0.3, 0.4, 'rsyslogd'],
    [1900, 'root', 20, 0.1, 0.2, 'cron'],
    [2000, 'songmin', 20, 4.2, 2.8, 'pnpm'],
    [2100, 'songmin', 20, 6.3, 4.1, 'vitest'],
    [2200, 'root', 20, 0.0, 0.1, 'agetty'],
    [2300, 'avahi', 20, 0.0, 0.1, 'avahi-daemon'],
    [2400, 'dbus', 20, 0.1, 0.2, 'dbus-daemon'],
    [2500, 'root', 20, 0.2, 0.4, 'NetworkManager'],
    [2600, 'songmin', 20, 0.0, 0.3, 'gvfsd'],
  ];
  for (let i = 0; i < base.length; i += 1) {
    const [pid, user, pr, cpu, mem, cmd] = base[i];
    const offset = cpuOffsets[i] ?? 0;
    lines.push(procRow(pid, user, pr, cpu + offset, mem, cmd));
  }
  // Ensure we fill exactly ROWS lines (truncating excess if any).
  while (lines.length < ROWS) lines.push('');
  return lines.slice(0, ROWS);
}

/** Emit a frame: for each row r, CSI <r+1>;1H + the line. */
function paintFrame(lines) {
  const out = [];
  for (let r = 0; r < lines.length; r += 1) {
    out.push(...bytes(...CSI, `${r + 1};1H`));
    out.push(...bytes(lines[r].slice(0, COLS)));
  }
  return out;
}

// ---------- Pre-alt main-buffer scroll segment ----------
// Agent S audit recommendation (wave 3): before the alt-screen cycle,
// emit enough main-buffer content to force row eviction. The screen is
// 24 rows tall, so we print ~30 rows of `$ echo warmup N` + `warmup N`
// output. Each `\r\n` at the bottom of the visible grid scrolls the top
// row off; those rows land in the scrollback ring, letting CP 0 assert a
// concrete `scrollback.rows[0].text` instead of just `rowCount === 0`.
const WARMUP_LINES = 30;
const warmupScroll = (() => {
  const out = [];
  for (let i = 0; i < WARMUP_LINES; i += 1) {
    out.push(...bytes(`line-${String(i).padStart(2, '0')}: warmup\r\n`));
  }
  return out;
})();

// Phase 1: shell prompt (preceded by warmup lines so scrollback captures).
const phase1 = bytes('$ top\r\n');

// Phase 2: enter alt.
const enter1049 = bytes(...CSI, '?1049h');
const cursorHome = bytes(...CSI, 'H');

// Frames — frame 2 and 3 tweak a couple of CPU offsets to simulate
// updated ticks without fully restructuring the row.
const frame1 = paintFrame(frameLines([]));
const frame2Content = paintFrame(
  frameLines([0, 0, 0.3, -0.2, 0.5, -0.4, 0, 0, 0, 0, 0, 0.8, -0.6, 0, 0, 0, 0, 0]),
);
const frame3Content = paintFrame(
  frameLines([0, 0, -0.1, 0.4, 0.2, 0.6, 0, 0, 0, 0, 0, -0.3, 1.1, 0, 0, 0, 0, 0]),
);

const eraseDisplay = bytes(...CSI, '2J');
const exit1049 = bytes(...CSI, '?1049l');
const postPrompt = bytes('$ ');

// ---------- Assemble + checkpoints ----------
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

// --- CP 0: after warmup scroll — scrollback captured concrete content ---
// 30 warmup lines x (text + \r\n) scroll the main buffer; only the
// bottom 24 rows (= ROWS) remain on-screen, so >= (30 - ROWS + 1) rows
// land in the scrollback ring. The oldest surviving scrollback row is
// `line-00: warmup` because scrollback is oldest-first and the top
// rows fall off first. This positively validates the Epic α3 capture
// path — not just "rowCount stayed zero during alt" (which we still
// assert later) but "evicted rows carry the correct content".
appendChunk(warmupScroll);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After warmup scroll — main-buffer eviction populated the scrollback ring with concrete `line-NN` content.',
  expected: {
    mode: { altScreen: false },
    scrollback: {
      rows: {
        0: { textIncludes: 'line-00: warmup' },
      },
    },
  },
});

// --- CP 1: after DECSET 1049h + cursor home ---
appendChunk(phase1);
appendChunk(enter1049);
appendChunk(cursorHome);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049h + CSI H — alt buffer active, grid cleared, cursor at origin. Scrollback still holds the pre-alt warmup rows (count pinned).',
  expected: {
    cursor: { row: 0, col: 0 },
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '', widths: Array(COLS).fill(1) },
      1: { text: '', widths: Array(COLS).fill(1) },
    },
    // `$ top\r\n` adds one final eviction on top of the warmup. Exact
    // count = WARMUP_LINES + 1 (phase1 line) - (ROWS - 1) rows that
    // remain visible just before 1049h swap. Keep the assertion
    // expressive and derived so tweaks to WARMUP_LINES propagate.
    scrollback: { rowCount: WARMUP_LINES + 1 - (ROWS - 1) },
  },
});

// --- CP 2: after frame 1 paint — row 0 holds the top header ---
appendChunk(frame1);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After top frame 1 paint — row 0 contains the top header line.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: {
        text: HEADER_ROW_0.slice(0, COLS),
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- Frame 2 (no checkpoint of its own — just feed) ---
appendChunk(eraseDisplay);
appendChunk(frame2Content);

// --- CP 3: after frame 3 — still alt; scrollback is PINNED to pre-alt count ---
// This is the load-bearing assertion of the whole fixture. If rapid
// alt-buffer repaints ever start leaking into the main-buffer ring,
// `rowCount` will climb ABOVE the pre-alt pinned value and this fails.
// The pinned value is the same as CP 1 — alt repaints contribute nothing.
appendChunk(eraseDisplay);
appendChunk(frame3Content);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After top frame 3 — still in alt buffer; scrollback ring row count is PINNED to pre-alt value (alt repaints never leak).',
  expected: {
    mode: { altScreen: true },
    scrollback: { rowCount: WARMUP_LINES + 1 - (ROWS - 1) },
    selected_rows: {
      0: {
        text: HEADER_ROW_0.slice(0, COLS),
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- CP 4: after DECSET 1049l — main buffer has `$ top` ---
// The main buffer is restored exactly as it was at CP 1. Its on-screen
// content (the bottom ROWS of the pre-alt stream) had `$ top` on row
// ROWS-2, and the row immediately above that was `line-29: warmup`.
// Post-restore, the cursor returns to the pre-1049h position, which is
// row ROWS-1 (just below `$ top`, where the shell had advanced to after
// emitting `\r\n`). Scrollback stays at the pre-alt pinned count.
appendChunk(exit1049);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l — main buffer restored with `$ top` near the bottom of the visible grid; alt content discarded. Scrollback count is unchanged from CP 1.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      // `$ top` sits on row ROWS-2 of the restored main buffer (see CP 1).
      [ROWS - 2]: { text: '$ top', widths: Array(COLS).fill(1) },
    },
    scrollback: {
      rowCount: WARMUP_LINES + 1 - (ROWS - 1),
      rows: {
        0: { textIncludes: 'line-00: warmup' },
      },
    },
  },
});

// --- CP 5: after shell reprints `$ ` — final cursor position ---
// The post-exit prompt lands on the pre-1049h cursor row (ROWS-1, the
// last row of the visible grid). `$ ` writes two cells; cursor ends at
// (ROWS-1, 2). Scrollback count still pinned.
appendChunk(postPrompt);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After post-exit `$ ` — cursor at row ROWS-1 col 2; main buffer shows the new prompt on the bottom row.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      // Trailing space preserved — see projectRow in compat-replay.ts.
      [ROWS - 1]: { text: '$ ', widths: Array(COLS).fill(1) },
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
      id: 'C-MON-01',
      kind: 'synthetic',
      snapshotFormatVersion: 1,
      shell: 'synthetic-bash-like',
      cols: COLS,
      rows: ROWS,
      description:
        'top session: 30 main-buffer warmup lines (scroll + scrollback capture) → DECSET 1049h → 3 alt-buffer repaint frames → DECSET 1049l → main buffer restored. Scrollback row count is pinned across the alt cycle; evicted row content is positively asserted.',
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
