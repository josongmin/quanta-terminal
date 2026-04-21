#!/usr/bin/env node
/**
 * SYNTHETIC C-ED-03 fixture generator — vim `:!bash` nested subshell.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream (no live PTY recording
 * yet; `tools/compat-record` still pending per Plan 0005 Epic ε §6).
 *
 * What this fixture adds over C-ED-01 / C-ED-02
 * ---------------------------------------------
 * C-ED-01 and C-ED-02 cover vim's basic alt-screen round-trip. C-ED-03
 * exercises the `:!bash` pattern — vim spawns a subshell that runs
 * INSIDE vim's alt buffer. The critical contract under test:
 *
 *   alt_screen flips exactly ONCE on 1049h, stays true through the
 *   entire nested bash lifecycle, and flips back to false only when
 *   vim exits on :q! 's 1049l.
 *
 * Concretely: bash running inside `:!` does NOT issue its own 1049h/
 * 1049l pair. Vim has already put the terminal in alt mode; bash just
 * draws on top of vim's screen, and when bash exits, vim repaints the
 * screen itself (erase + re-paint tildes + status line). The outer
 * `alt_screen` never dips to `false` during the inner bash.
 *
 * Scenario
 * --------
 *   1. Main buffer: `$ vim file.txt\r\n`.
 *   2. DECSET 1049h (vim enters alt). alt_screen flips to true.
 *   3. Vim paints: clear, cursor home, 5 rows of tildes on rows 1..5,
 *      reverse-video status line `"file.txt" [New]` on row ROWS-1.
 *   4. User types `:!bash\r` — vim shows `:!bash` on the status line.
 *   5. Vim clears the screen and the inner bash prompt appears at row 0
 *      (not nested alt — vim just delegates the screen). bash runs
 *      `echo hi` (output `hi`), then a fresh prompt.
 *   6. User types `exit` + `\r\n` — bash exits. Vim REPAINTS its own
 *      UI: erase, tildes back on rows 1..5, status line restored.
 *   7. Throughout steps 4-6, NO 1049h/1049l are emitted — alt_screen
 *      stays true the whole time.
 *   8. User types `:q!\r` — vim exits. DECSET 1049l — alt_screen flips
 *      back to false, main buffer restores with `$ vim file.txt` on row 0.
 *   9. Post-exit shell prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-ED-03/build-fixture.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ESC = 0x1b;
const CSI = [ESC, 0x5b]; // ESC [
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
// 40 cols × 8 rows keeps snapshots reviewable; enough height for 5
// tildes + blank + status row.
const COLS = 40;
const ROWS = 8;

const STATUS_ROW_0IDX = ROWS - 1; // 0-indexed status row
const STATUS_ROW_1IDX = ROWS;     // 1-indexed (for CSI moves)

const STATUS_LABEL = '"file.txt" [New]';

// ---------- Paint helpers ----------
function paintAt(row1, col1, text) {
  return bytes(...CSI, `${row1};${col1}H`, text);
}

/** vim's initial-file paint: tildes on rows 1..ROWS-2 + status line. */
function paintVimInitial() {
  const out = [];
  // Erase entire display, cursor home.
  out.push(...bytes(...CSI, '2J'));
  out.push(...bytes(...CSI, 'H'));
  // Tildes on rows 1..ROWS-2 (skipping the empty-content row 0).
  for (let r = 1; r < ROWS - 1; r += 1) {
    out.push(...paintAt(r + 1, 1, '~'));
  }
  // Reverse-video status line on the last row.
  out.push(
    ...bytes(
      ...CSI,
      `${STATUS_ROW_1IDX};1H`,
      ...CSI,
      '7m',
      STATUS_LABEL,
      ...CSI,
      '0m',
    ),
  );
  return out;
}

/** vim shows `:!bash` on the status line (no longer reverse-video —
 *  real vim drops the inverse attribute when it enters command-line
 *  mode). `CSI K` erases the rest of the row first so the prior
 *  reverse-video status label doesn't linger to the right of `:!bash`. */
function paintStatusColon(label) {
  return bytes(
    ...CSI,
    `${STATUS_ROW_1IDX};1H`,
    ...CSI,
    '0m', // reset SGR before erasing, so cleared cells are default.
    ...CSI,
    'K',  // erase to end of line.
    label,
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
appendChunk(bytes('$ vim file.txt\r\n'));

// --- Phase 2: enter alt ---
appendChunk(bytes(...CSI, '?1049h'));

// --- CP 1: alt entered, grid blank (swapAlt clears alt buffer) ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After outer DECSET 1049h — alt_screen flips to true; grid cleared by the entry clear.',
  expected: {
    mode: { altScreen: true },
  },
});

// --- Phase 3: vim paints empty-file UI ---
appendChunk(paintVimInitial());

// --- CP 2: vim UI painted — row 1 has a tilde ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After vim initial paint — rows 1..ROWS-2 hold tildes, status row shows "file.txt" [New].',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      1: { text: '~', widths: Array(COLS).fill(1) },
      [STATUS_ROW_0IDX]: {
        text: STATUS_LABEL,
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- Phase 4: user types `:!bash<CR>` — vim paints it on the status line ---
appendChunk(paintStatusColon(':!bash'));

// --- CP 3: status line now reads `:!bash` ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After vim paints `:!bash` on the status line — status row shows the command prompt.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      [STATUS_ROW_0IDX]: {
        text: ':!bash',
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- Phase 5: vim delegates the screen to the inner bash ---
// Clear + home, then inner bash prints a prompt, the `echo hi` session,
// and a fresh prompt. CRITICALLY: no 1049h is emitted — bash inherits
// vim's alt screen.
appendChunk(bytes(...CSI, '2J', ...CSI, 'H'));
// Bash banner-style "Press ENTER or type command to continue" would go
// on the first row in real vim; we keep the scenario tight and put the
// bash prompt directly at row 0.
appendChunk(bytes('$ echo hi\r\n'));
appendChunk(bytes('hi\r\n'));
appendChunk(bytes('$ '));

// --- CP 4: inner bash visible — rows 0..2 show the bash session; alt_screen STILL true ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After inner bash prints `echo hi` + output + fresh prompt — alt_screen is STILL true because bash runs inside vim\'s alt buffer (no nested 1049).',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '$ echo hi', widths: Array(COLS).fill(1) },
      1: { text: 'hi', widths: Array(COLS).fill(1) },
      2: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// --- Phase 6: bash exits; vim repaints its UI from scratch ---
// In real vim, `exit<CR>` leaves bash and vim prints "Press ENTER or
// type command to continue" then repaints. We skip the "press ENTER"
// intermediate and go straight to the full repaint — the behaviour
// under test is the alt_screen invariant across the handoff, not the
// vim-specific prompt text.
appendChunk(paintVimInitial());

// --- CP 5: vim's UI fully restored — tildes back, bash session erased ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After vim repaints on bash exit — tildes restored, status line back, bash output erased. alt_screen still true.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      // Row 0 is content-empty (no file content); row 1 holds a tilde.
      0: { text: '', widths: Array(COLS).fill(1) },
      1: { text: '~', widths: Array(COLS).fill(1) },
      [STATUS_ROW_0IDX]: {
        text: STATUS_LABEL,
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- CP 6: dedicated sanity check — alt_screen still true after bash exit ---
// This is the same byte offset as CP 5, but the separate checkpoint
// makes the invariant legible in the fixture's list: the alt flip
// happens EXACTLY ONCE, and we're still on the first flip.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Sanity: alt_screen has flipped exactly ONCE (on the outer 1049h). Nested bash did NOT produce its own 1049 cycle.',
  expected: {
    mode: { altScreen: true },
  },
});

// --- Phase 7: user types `:q!<CR>` — vim exits on 1049l ---
appendChunk(bytes(...CSI, '?1049l'));

// --- CP 7: main buffer restored — alt_screen false, pre-entry prompt visible ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After vim exits via :q! (DECSET 1049l) — alt_screen flips back to false, main buffer restores with `$ vim file.txt` on row 0.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ vim file.txt',
        widths: Array(COLS).fill(1),
      },
      1: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- Phase 8: shell reprints `$ ` on the restored main buffer ---
appendChunk(bytes('$ '));
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After post-exit shell prompt — main buffer row 1 shows the new `$ ` prompt; alt_screen still false.',
  expected: {
    cursor: { row: 1, col: 2 },
    mode: { altScreen: false },
    selected_rows: {
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
        "vim :!bash nested subshell: outer DECSET 1049h puts the terminal in alt; inner bash runs inside vim's alt buffer (no nested 1049); vim repaints on bash exit; DECSET 1049l exits vim. alt_screen state flips exactly once.",
      authoredAt: '2026-04-21T00:00:00Z',
      synthetic: true,
    },
    null,
    2,
  ) + '\n',
);

// Keep createHash import used even though this fixture doesn't compute
// sgrDigest — future checkpoints may opt into it.
void createHash;

console.log(
  `wrote ${stream.length} bytes to input.bytes; ${checkpoints.length} checkpoints.`,
);
