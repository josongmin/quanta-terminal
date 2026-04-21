#!/usr/bin/env node
/**
 * SYNTHETIC C-NET-01 fixture generator — `ssh localhost echo hi`.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream (no live PTY recording
 * yet; `tools/compat-record` pending per Plan 0005 Epic ε §6).
 *
 * What this fixture asserts
 * -------------------------
 * Simplest possible SSH round-trip: local bash invokes `ssh localhost
 * echo hi`, the remote shell runs the one-shot command, emits `hi\r\n`,
 * and the ssh connection closes cleanly so the local prompt reappears.
 *
 * From the engine's POV the SSH transport is transparent — we just see a
 * multiplexed byte stream:
 *
 *   1. Local: `$ ssh localhost echo hi\r\n` (command line).
 *   2. Remote command output: `hi\r\n`.
 *   3. Local: `$ ` (next prompt after ssh disconnects).
 *
 * NO alt-screen at any point (ssh non-interactive mode never enters alt).
 * NO SGR. Pure main-buffer transcript — if this fails, every richer
 * SSH / interactive compat scenario built on top collapses.
 *
 * We deliberately DO NOT include the interactive first-connect banner
 * (`The authenticity of host 'localhost' ...`): for a non-interactive
 * one-shot with `BatchMode=yes` or a cached host key, ssh emits no
 * banner at all. Keeping the stream minimal matches the most common
 * case and makes the row layout easier to reason about.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-NET-01/build-fixture.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
// 60 cols × 8 rows is plenty for a 3-line transcript with no risk of
// scroll, and leaves room for the longer SSH command line.
const COLS = 60;
const ROWS = 8;

// Row layout after the full sequence:
//   row 0: `$ ssh localhost echo hi`
//   row 1: `hi`
//   row 2: `$ ` (cursor parked here at col 2)

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

function blankWidths() {
  return Array(COLS).fill(1);
}

// --- Phase 1: local prompt + ssh command typed ---
// `$ ssh localhost echo hi\r\n` — prompt + command land on row 0; `\r\n`
// drops to row 1.
appendChunk(bytes('$ ssh localhost echo hi\r\n'));

// --- CP 1: command line visible on row 0 ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After the ssh command line is typed — row 0 has `$ ssh localhost echo hi`, cursor on row 1 col 0. No alt-screen.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ ssh localhost echo hi', widths: blankWidths() },
      1: { text: '', widths: blankWidths() },
    },
  },
});

// --- Phase 2: remote shell runs `echo hi` → emits `hi\r\n` ---
appendChunk(bytes('hi\r\n'));

// --- CP 2: remote output visible ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After remote `hi\\r\\n` — row 1 holds the command output, cursor advanced to row 2 col 0. Still no alt-screen.',
  expected: {
    cursor: { row: 2, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ ssh localhost echo hi', widths: blankWidths() },
      1: { text: 'hi', widths: blankWidths() },
      2: { text: '', widths: blankWidths() },
    },
  },
});

// --- Phase 3: ssh disconnects cleanly; local shell reprints `$ ` ---
appendChunk(bytes('$ '));

// --- CP 3: local prompt back, main buffer ends with `$ ` ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After ssh disconnect + local prompt reprint — row 2 holds `$ `, cursor parked at row 2 col 2. Transcript remains byte-exact on rows 0-2.',
  expected: {
    cursor: { row: 2, col: 2 },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ ssh localhost echo hi', widths: blankWidths() },
      1: { text: 'hi', widths: blankWidths() },
      2: { text: '$ ', widths: blankWidths() },
    },
  },
});

// --- CP 4: scrollback still empty; altScreen never flipped ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Invariant: altScreen stayed false across the whole round-trip, and no rows were evicted to scrollback.',
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
      shell: 'synthetic-bash-ssh',
      cols: COLS,
      rows: ROWS,
      description:
        'ssh localhost echo hi: non-interactive one-shot round-trip over SSH. Local prompt → ssh command → remote `hi` output → clean disconnect → local prompt. Pure main-buffer transcript; engine sees ssh as a transparent byte stream.',
      authoredAt: '2026-04-21T00:00:00Z',
      kind: 'synthetic',
      id: 'C-NET-01',
      snapshotFormatVersion: 1,
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `wrote ${stream.length} bytes to input.bytes; ${checkpoints.length} checkpoints.`,
);
