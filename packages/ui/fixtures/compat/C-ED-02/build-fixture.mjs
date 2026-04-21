#!/usr/bin/env node
/**
 * SYNTHETIC C-ED-02 fixture generator — `nvim` + LSP-style diagnostic.
 *
 * Plan 0005 P0 Epic ε. Hand-authored byte stream (no live PTY recording
 * yet — `tools/compat-record` still pending per Plan 0005 Epic ε §6).
 *
 * What this fixture adds over C-ED-01
 * -----------------------------------
 * C-ED-01 proves the alt-buffer round-trip. C-ED-02 layers on top with
 * two new assertions:
 *
 *   1. A reverse-video status line carrying a file name — tests that
 *      nvim-style status painting (SGR 7 + text + SGR 0 reset) lands
 *      stably across the alt-buffer paint, checkpointed with `sgrDigest`.
 *
 *   2. An inline diagnostic marker: SGR 48;5;203 (256-colour red bg) on a
 *      single character cell inside the buffer content. This is how LSP
 *      over nvim-cmp / builtin `diagnostic.virtual_text` typically
 *      visualises a type error — one character (or a small range) gets a
 *      red bg. The `sgrDigest` on the diagnostic row is the load-bearing
 *      byte-for-byte assertion: if SGR 48;5;203 is dropped, merged, or
 *      misapplied by the engine, the digest changes.
 *
 * Scenario
 * --------
 *   1. Shell prompt `$ nvim /tmp/hello.ts\r\n`.
 *   2. DECSET 1049h (enter alt) + clear + home.
 *   3. Paint 5 rows of TypeScript content. Row 2 is:
 *        `const x: string = 42;`
 *      — the `42` is a type error (type `number` not assignable to
 *      `string`).
 *   4. Repaint row 2 with a red background on the `4` of `42` (the start
 *      of the diagnostic range). Real LSP would highlight the whole `42`
 *      range; one char is enough to test the engine contract.
 *   5. Status line on the last row (reverse video): `/tmp/hello.ts`.
 *   6. DECSET 1049l — exit; post-exit prompt.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-ED-02/build-fixture.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ESC = 0x1b;
const CSI = [ESC, 0x5b]; // ESC [
const enc = new TextEncoder();

/** Concatenate any mix of `number`, `number[]`, strings into bytes. */
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
// Deliberately tight so the checkpoint snapshots stay reviewable. 7 rows
// leaves room for 5 code rows + 1 blank + status line on the last row.
const COLS = 40;
const ROWS = 7;

// The TypeScript file content. Row 2 (0-indexed) holds the type error.
const CODE_LINES = [
  '// hello.ts',
  '',
  'const x: string = 42;',
  '',
  'console.log(x);',
];

// Phase 1: main-buffer prompt + command.
const phase1 = bytes('$ nvim /tmp/hello.ts\r\n');

// Phase 2: enter alt + clear + home.
const enter1049 = bytes(...CSI, '?1049h');
const clearAndHome = bytes(...CSI, '2J', ...CSI, 'H');

// Phase 3: paint the 5 code rows at rows 0..4 using absolute moves.
function paintCode() {
  const out = [];
  for (let r = 0; r < CODE_LINES.length; r += 1) {
    out.push(...bytes(...CSI, `${r + 1};1H`));
    const line = CODE_LINES[r].slice(0, COLS);
    out.push(...bytes(line));
  }
  return out;
}
const codePaint = paintCode();

// Phase 4: diagnostic overlay — repaint the `4` of `42` with SGR
// 48;5;203 (256-colour red bg). Row 2, col 18 (1-indexed 19) is the
// position of `4` in `const x: string = 42;` (counting:
// `const x: string = ` → 18 chars, then `42;`).
//
// Bytes:
//   CSI 3;19H              — move to row 3 col 19 (1-indexed)
//   CSI 48;5;203m          — set bg to 256-colour index 203
//   "4"                    — paint the one character with bg
//   CSI 0m                 — reset SGR so subsequent output is clean
const diagnosticMarker = bytes(
  ...CSI,
  '3;19H',
  ...CSI,
  '48;5;203m',
  '4',
  ...CSI,
  '0m',
);

// Phase 5: reverse-video status line on row ROWS-1 (1-indexed ROWS).
// Matches C-ED-01's status-bar pattern.
const statusBar = bytes(
  ...CSI,
  `${ROWS};1H`,
  ...CSI,
  '7m',
  '/tmp/hello.ts',
  ...CSI,
  '0m',
);

// Phase 6: exit alt + post-exit shell prompt.
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

// --- CP 1: after DECSET 1049h + clear — alt active, cursor home ---
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
    },
  },
});

// --- CP 2: after code paint — row 2 has the TypeScript with the type error ---
appendChunk(codePaint);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After nvim paints 5 rows of TypeScript content — row 2 holds `const x: string = 42;`.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: { text: CODE_LINES[0], widths: Array(COLS).fill(1) },
      2: { text: CODE_LINES[2], widths: Array(COLS).fill(1) },
      4: { text: CODE_LINES[4], widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 3: after diagnostic marker — row 2 still reads the same text,
// but with SGR bg=203 on the `4`. Byte-for-byte digest check via
// `sgrDigest`. We compute the expected digest lazily at test time
// (the harness recomputes the digest from the live grid and we compare);
// here we include `sgrDigest: '__PLACEHOLDER__'` and REPLACE below with
// the actual computed digest by loading + feeding the stream ourselves.
//
// Authoring approach: we know the digest is deterministic, but computing
// it requires the full classifier/width chain. Rather than duplicate
// that in the build script, we OMIT the digest here and let the test
// harness self-capture it on first run — see harness note.
//
// To keep the fixture strictly deterministic and self-authoring without
// requiring any runtime cross-checks, we instead write the marker row
// with a digest we compute directly from the SGR tuple structure.
// However, because the precise digest format depends on
// `compat-replay.ts:sgrTupleFor`, we cannot easily reproduce it here.
// Solution: stash the expected digest INSIDE the test (not the fixture)
// — the test captures the digest from the live run and asserts that the
// row *has* a digest that's stable between runs.
//
// Simpler path taken here: we INCLUDE an `sgrDigest` in the checkpoint,
// computed at build time by replicating `sgrTupleFor` in-script. This
// keeps the fixture self-describing and the test stays a pure equality
// check. See `computeExpectedDigest()` below.
appendChunk(diagnosticMarker);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After LSP diagnostic paint — row 2 text unchanged, but `4` (col 18) carries SGR 48;5;203 (red bg). sgrDigest is load-bearing.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      2: {
        text: CODE_LINES[2],
        widths: Array(COLS).fill(1),
        // Computed from scenario:
        //   cols 0..17: default fg + default bg, no flags
        //   col 18:     default fg + indexed 203 bg, no flags
        //   cols 19..20: default fg + default bg (the `2;` pair)
        //   cols 21..39: default everywhere
        sgrDigest: computeExpectedDigestForCp3(),
      },
    },
  },
});

// --- CP 4: after status line painted ---
appendChunk(statusBar);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After reverse-video status bar on last row — `/tmp/hello.ts` with SGR 7 inverse. sgrDigest asserts the inverse attribute is preserved.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      [ROWS - 1]: {
        text: '/tmp/hello.ts',
        widths: Array(COLS).fill(1),
        sgrDigest: computeExpectedDigestForCp4(),
      },
    },
  },
});

// --- CP 5: after DECSET 1049l — main buffer restored ---
appendChunk(exit1049);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l — main buffer restored with `$ nvim /tmp/hello.ts` on row 0, cursor at pre-entry row 1 col 0.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ nvim /tmp/hello.ts',
        widths: Array(COLS).fill(1),
      },
      1: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 6: after post-exit prompt ---
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

// ---------- SGR digest computation (mirrors compat-replay.ts) ----------
/**
 * Compute a per-cell SGR tuple string. Mirrors `sgrTupleFor` in
 * `compat-replay.ts`:
 *   - fg/bg: `d` for default, `kind:index` for named/bright/indexed,
 *     `rgb:r,g,b` for truecolor.
 *   - flags: 8-bit packed bold/italic/underline/inverse/strike/dim/hidden/blink.
 */
function cellTuple({ fg = 'd', bg = 'd', flags = 0 } = {}) {
  return `${fg},${bg},${flags}`;
}

/** SHA-256 hex digest using node's `crypto`. Inlined so the build script
 *  has zero runtime deps on the test harness. */
function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** CP 3 row projection: row 2 after the diagnostic marker.
 *  Row text is `const x: string = 42;` (21 graphemes) — the rest is
 *  blank default cells up to COLS. Col 18 = `4` has bg=indexed:203. */
function computeExpectedDigestForCp3() {
  const parts = [];
  for (let c = 0; c < COLS; c += 1) {
    if (c === 18) {
      parts.push(cellTuple({ fg: 'd', bg: 'indexed:203', flags: 0 }));
    } else {
      parts.push(cellTuple());
    }
  }
  return sha256Hex(parts.join('|'));
}

/** CP 4 row projection: status row. `/tmp/hello.ts` is 13 chars, all with
 *  inverse (SGR 7 → flags bit 3 = 0x08). Remaining cells are default. */
function computeExpectedDigestForCp4() {
  const parts = [];
  const label = '/tmp/hello.ts';
  for (let c = 0; c < COLS; c += 1) {
    if (c < label.length) {
      // flags bit 3 = inverse
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
      shell: 'synthetic-bash-like',
      cols: COLS,
      rows: ROWS,
      description:
        'nvim /tmp/hello.ts with LSP diagnostic overlay: alt-buffer paint, reverse-video status bar, inline SGR 48;5;203 marker preserved byte-for-byte across 1049 cycle.',
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
