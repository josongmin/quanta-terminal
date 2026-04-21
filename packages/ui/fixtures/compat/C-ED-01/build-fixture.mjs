#!/usr/bin/env node
/**
 * SYNTHETIC C-ED-01 fixture generator.
 *
 * This script is the authoring tool for the `input.bytes` and
 * `checkpoints.json` files in this directory. The fixture is SYNTHETIC —
 * it was authored by hand, not recorded from a live PTY. Once
 * `tools/compat-record` lands (Plan 0005 Epic ε §6), a real recording
 * of `vim :q<return>` will replace this synthetic stream.
 *
 * Why ship the generator?
 *   - The byte stream is several hundred bytes of mixed-escape binary.
 *     Reviewers need to see WHAT each byte means, and diffs on
 *     `input.bytes` are unreadable. Keeping the generator in-tree means
 *     the fixture is self-describing and regenerable.
 *   - Changes to the scenario (e.g. widening the status bar, adding a
 *     keystroke) happen here, not by hand-hexing the bytes file.
 *
 * Re-run with: `node packages/ui/fixtures/compat/C-ED-01/build-fixture.mjs`.
 * Exit status is 0 on success; prints summary of bytes written.
 *
 * NOTE: checkpoint "expected" row projections encode the CORRECT (post
 * Epic α) behaviour, not the current emulator's. That's intentional —
 * this fixture doubles as the RED test that flips green when the
 * alt-screen swap lands.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ESC = 0x1b;
const CSI = [ESC, 0x5b]; // ESC [
const enc = new TextEncoder();

/** Concatenate any mix of `number`, `number[]`, and `Uint8Array` / string. */
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

// ---------- Scenario ----------
// Cols=40, Rows=6 (kept small so checkpoint snapshots stay reviewable).
const COLS = 40;
const ROWS = 6;

// Phase 1: Main-buffer prompt + command.
const phase1 = bytes('$ vim /tmp/sample.txt\r\n');

// Phase 2: Enter alt-screen (DECSET 1049h), clear, home cursor.
//   CSI ? 1 0 4 9 h  — enter alt
//   CSI 2 J           — erase display
//   CSI H             — cursor home (1;1)
const enter1049 = bytes(...CSI, '?1049h');
const clearAndHome = bytes(...CSI, '2J', ...CSI, 'H');

// Phase 3: Draw vim's empty-buffer "~" tildes on rows 1..ROWS-2 (row 0
// is content row — initially empty in a new file).
// Each row is "~\r\n" so we advance one row at a time.
/** @type {number[]} */
const tildes = [];
for (let r = 1; r < ROWS - 1; r += 1) {
  // Move cursor to row r+1 col 1 (1-indexed in CSI), then print "~".
  // Simpler: CR + "~\n" moves to col 0 then next line.
  tildes.push(...bytes(...CSI, `${r + 1};1H`, '~'));
}

// Phase 4: Reverse-video status bar on the last row.
//   CSI <ROWS>;1H     — move to bottom-left
//   CSI 7m            — inverse video on
//   "-- INSERT --"    (just the label; trailing columns stay blank)
//   CSI 0m            — reset
// Note: we deliberately DO NOT pad the label with trailing spaces.
// Real vim paints a full-row inverse background by writing spaces
// with the inverse SGR active — those spaces are structurally
// graphemes, not blanks, so the row projection would include them.
// Here we want the smallest reviewable snapshot, so we leave the
// trailing columns blank. Fixtures that care about reverse-video
// fill MUST opt into `sgrDigest` on the checkpoint row.
const statusBar = bytes(
  ...CSI,
  `${ROWS};1H`,
  ...CSI,
  '7m',
  '-- INSERT --',
  ...CSI,
  '0m',
);

// Phase 5: Move cursor to row 1 col 1 and insert "hello world".
const insertText = bytes(...CSI, '1;1H', 'hello world');

// Phase 6: Exit alt-screen (DECSET 1049l). The main buffer's pre-entry
// content ("$ vim /tmp/sample.txt\n" on row 0, cursor at row 1) should
// restore verbatim. Then the shell re-emits the prompt ("$ ").
const exit1049 = bytes(...CSI, '?1049l');
const postPrompt = bytes('$ ');

// ---------- Assemble stream + record checkpoint offsets ----------
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

// --- CP 0: after phase1 (main prompt written, before 1049h) ---
appendChunk(phase1);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After shell prints "$ vim /tmp/sample.txt\\r\\n" — main buffer row 0 holds the command, cursor at row 1 col 0.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ vim /tmp/sample.txt',
        widths: Array(COLS).fill(1),
      },
      1: {
        text: '',
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- CP 1: after DECSET 1049h (alt-screen active, grid cleared) ---
// Note: we also feed the clear+home so the screen is actually blank.
appendChunk(enter1049);
appendChunk(clearAndHome);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049h + CSI 2J + CSI H — alt buffer is active, grid cleared, cursor at origin.',
  expected: {
    cursor: { row: 0, col: 0 },
    // Epic α contract: `alt_screen` flips to true on DECSET 1049h. Until
    // Epic α lands, this assertion is the RED marker.
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '', widths: Array(COLS).fill(1) },
      1: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 2: after tildes + status bar drawn ---
appendChunk(tildes);
appendChunk(statusBar);
// Cursor is parked at the end of the status bar on the last row; insert
// moves it back to row 1 col 1 next.
//
// Agent S audit recommendation (wave 3): attach `sgrDigest` to the status
// row so drift in the reverse-video attribute (SGR 7 → inverse bit) or
// on the character range is caught here. Label is 12 graphemes
// (`-- INSERT --`), each with inverse ON (flags bit 3 = 0x08); remaining
// cells default.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After vim-like initial paint: tildes on rows 1..4, reverse-video status bar on row 5. sgrDigest pins the inverse attribute across the label range.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      1: { text: '~', widths: Array(COLS).fill(1) },
      2: { text: '~', widths: Array(COLS).fill(1) },
      3: { text: '~', widths: Array(COLS).fill(1) },
      4: { text: '~', widths: Array(COLS).fill(1) },
      5: {
        text: '-- INSERT --',
        widths: Array(COLS).fill(1),
        sgrDigest: computeInsertStatusDigest(),
      },
    },
  },
});

// --- CP 3: after "hello world" inserted on alt-buffer row 0 ---
appendChunk(insertText);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After cursor reset + insertion of "hello world" — alt buffer row 0 contains the text.',
  expected: {
    cursor: { row: 0, col: 11 },
    mode: { altScreen: true },
    selected_rows: {
      0: {
        text: 'hello world',
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- CP 4: after DECSET 1049l (exit alt) — the critical assertion ---
// Main buffer restores: row 0 shows the pre-entry command, and vim's
// "hello world" must be gone. Cursor returns to its pre-1049h position
// (row 1 col 0) per xterm's 1049-mode save/restore contract.
appendChunk(exit1049);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l — main buffer restored, alt buffer discarded. "hello world" must NOT be visible. Cursor back at pre-1049h position.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ vim /tmp/sample.txt',
        widths: Array(COLS).fill(1),
      },
      1: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 5: after shell reprints "$ " ---
// Trailing space is preserved in the projection — `$ ` writes two cells
// (`$` then ` `) and both have non-empty graphemes. Matches the
// C-PG-01 / C-MON-01 convention.
appendChunk(postPrompt);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After post-exit shell prompt "$ " — main buffer row 1 shows the new prompt.',
  expected: {
    cursor: { row: 1, col: 2 },
    mode: { altScreen: false },
    selected_rows: {
      1: {
        text: '$ ',
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// ---------- SGR digest helper (mirrors compat-replay.ts:sgrTupleFor) ----------
/**
 * Build the SHA-256 digest over per-cell SGR tuples for the status row.
 * The row contains `-- INSERT --` (12 graphemes) painted with SGR 7
 * (inverse) active; cells beyond the label are default. SGR 7 maps to
 * flags bit 3 (0x08) in `sgrTupleFor`.
 */
function computeInsertStatusDigest() {
  const parts = [];
  const LABEL = '-- INSERT --';
  for (let c = 0; c < COLS; c += 1) {
    if (c < LABEL.length) {
      // fg=default, bg=default, flags=0x08 (inverse)
      parts.push('d,d,8');
    } else {
      parts.push('d,d,0');
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
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
      id: 'C-ED-01',
      kind: 'synthetic',
      snapshotFormatVersion: 1,
      shell: 'synthetic-bash-like',
      cols: COLS,
      rows: ROWS,
      description:
        'vim round-trip: main-buffer prompt → DECSET 1049h → alt-buffer paint + insert → DECSET 1049l → main buffer restored, vim content gone.',
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
