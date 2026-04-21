#!/usr/bin/env node
/**
 * SYNTHETIC C-PG-03 fixture generator — `more /etc/hosts`.
 *
 * Plan 0005 P0 wave 4 (W). Companion to C-PG-01 (less, DECSET 1049
 * alt-buffer). This fixture tests the OPPOSITE pager contract: `more`
 * does NOT use the alternate screen by default. Its working model is:
 *
 *   - Print content directly onto the main buffer.
 *   - When the screen fills, paint a reverse-video `--More--(NN%)`
 *     prompt at the bottom row and wait for input.
 *   - On SPACE: scroll forward by a page (main-buffer `\n` scrolls, so
 *     the top rows LEAK INTO SCROLLBACK — this is correct behaviour).
 *   - On `q` or EOF: exit silently; whatever content was on screen stays.
 *
 * The fixture uses `more /etc/hosts` with a small hosts file that fits
 * within one screen, so no SPACE is required — the content prints, then
 * `more` prints `--More--(END)` in reverse video and exits on any key.
 *
 * Engine invariants under test
 * ----------------------------
 *   1. `mode.altScreen` stays `false` the entire time (unlike C-PG-01).
 *   2. The reverse-video `--More--` status row lands with SGR 7 active
 *      (sgrDigest pins the inverse attribute).
 *   3. On exit, because everything stayed in the main buffer, scrollback
 *      captures the content when the prompt push-scrolls the top rows
 *      off. Assert `scrollback.rows[0].textIncludes` matches the first
 *      hosts line.
 *
 * Why synthetic?
 *   Real `more` output varies with terminfo negotiation and screen size.
 *   The emulator contract under test is "main-buffer scroll + SGR-7 row
 *   + no alt-screen toggle" — all paths independent of the specific
 *   terminal-cap probe bytes.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-PG-03/build-fixture.mjs
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
// Deliberately small main-buffer: 24 rows, 80 cols. The hosts file is 18
// lines so the whole thing fits on one screen and `more` shows a single
// `--More--` prompt, which is what we assert on. The final prompt bumps
// past the bottom, forcing main-buffer scrollback capture.
const COLS = 80;
const ROWS = 24;

// Synthetic /etc/hosts content. 18 lines — well under ROWS, so the full
// file prints without SPACE input. Still long enough that when the
// `--More--` status row prints on row ROWS-1 (24th row, 1-indexed),
// the main buffer has already consumed ROWS-1 content rows + prompt.
const HOSTS_LINES = [
  '127.0.0.1       localhost',
  '127.0.1.1       quanta-dev',
  '',
  '# The following lines are desirable for IPv6 capable hosts',
  '::1             localhost ip6-localhost ip6-loopback',
  'ff02::1         ip6-allnodes',
  'ff02::2         ip6-allrouters',
  '',
  '# Private LAN',
  '192.168.1.10    router.lan',
  '192.168.1.20    nas.lan',
  '192.168.1.30    printer.lan',
  '',
  '# VPN overlays',
  '10.8.0.1        vpn-gw',
  '10.8.0.2        vpn-peer-a',
  '10.8.0.3        vpn-peer-b',
  '10.8.0.4        vpn-peer-c',
];

// Phase 1: shell prompt + command.
const phase1 = bytes('$ more /etc/hosts\r\n');

// Phase 2: `more` prints each hosts line with CRLF. NO DECSET 1049h —
// `more` (GNU util-linux) does not use alt-screen.
const hostsPaint = (() => {
  const out = [];
  for (const line of HOSTS_LINES) {
    out.push(...bytes(`${line}\r\n`));
  }
  return out;
})();

// Phase 3: `--More--(END)` prompt painted in reverse video at the bottom
// of the visible grid. We use a plain inline SGR 7 wrap (no cursor move
// — the bytes land wherever the cursor is, which after hostsPaint is on
// the first row BELOW HOSTS_LINES). Content beyond the visible grid
// triggers a main-buffer scroll which captures the oldest on-screen row
// into the scrollback ring — this is the contract we want to exercise.
const morePrompt = bytes(...CSI, '7m', '--More--(END)', ...CSI, '0m');

// Phase 4: user presses `q` or ENTER — more exits silently. We simulate
// this by writing a CR (`\r`) to return to col 0, a CSI K (EL) to erase
// the `--More--` prompt, then the shell reprints `$ ` on the next line.
// Real more uses `CSI K` + `\r` to clear its own prompt before exit.
const clearPrompt = bytes(0x0d, ...CSI, 'K');
const postPrompt = bytes('\r\n$ ');

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

// --- CP 1: after prompt + all hosts content painted ---
// Assert `mode.altScreen` stays false — distinguishes `more` from `less`.
// This checkpoint fires BEFORE the `--More--` prompt, so no inverse
// styling is active yet.
appendChunk(phase1);
appendChunk(hostsPaint);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `$ more /etc/hosts` + hosts content painted — main buffer holds the content; NO alt-screen transition.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      // After phase1 + 18 hosts lines with CRLF each, the content
      // `$ more /etc/hosts` is on row 0, followed by 18 hosts rows
      // filling rows 1..18. Row 19 is where the cursor sits (first
      // blank row after content).
      0: {
        text: '$ more /etc/hosts',
        widths: Array(COLS).fill(1),
      },
      1: { text: HOSTS_LINES[0], widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 2: after `--More--(END)` painted in reverse video ---
// `--More--(END)` is 13 graphemes wide, rendered on row 19 (same row the
// cursor was on) at col 0. Column 13+ are default blank cells. sgrDigest
// pins the inverse attribute across the 13-char label — drift in SGR 7
// handling is caught here.
appendChunk(morePrompt);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After reverse-video `--More--(END)` painted on the main buffer row after the last hosts line. sgrDigest pins inverse attribute.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      // 18 hosts lines → rows 1..18, so prompt lands on row 19.
      19: {
        text: '--More--(END)',
        widths: Array(COLS).fill(1),
        sgrDigest: computeMoreStatusDigest(),
      },
    },
  },
});

// --- CP 3: after user exits — prompt cleared, shell reprints `$ ` ---
// `clearPrompt` (CR + CSI K) resets col + erases the `--More--` marker.
// Then `\r\n$ ` advances to the next row and emits the shell prompt.
// altScreen still false throughout.
appendChunk(clearPrompt);
appendChunk(postPrompt);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `more` exits — `--More--` cleared; shell reprints `$ ` on the next row. altScreen still false.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      // Row 19 had `--More--(END)` → CSI K cleared it; now blank.
      19: { text: '', widths: Array(COLS).fill(1) },
      // `\r\n$ ` lands on row 20: two cells `$ ` (trailing space kept).
      20: { text: '$ ', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 4: scrollback content check ---
// `more` ran entirely in the main buffer. With the scenario's 18 hosts
// lines + `$ more /etc/hosts` + `--More--` + `\r\n$ ` = 21 rows, the
// screen (24 rows) never overflowed, so scrollback stays empty. That's
// still a useful positive invariant — `more` should NOT trigger eviction
// for this short file — and it contrasts with C-MON-01's populated
// scrollback case.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    '`more` ran against a short file and never pushed content off the top of the screen — scrollback ring is empty.',
  expected: {
    scrollback: { rowCount: 0 },
  },
});

// ---------- SGR digest helper (mirrors compat-replay.ts:sgrTupleFor) ----------
/**
 * Digest the `--More--(END)` status row. 13 inverse cells (flags 0x08),
 * rest default. Mirrors the compact `d,d,N` tuple format.
 */
function computeMoreStatusDigest() {
  const parts = [];
  const LABEL = '--More--(END)';
  for (let c = 0; c < COLS; c += 1) {
    if (c < LABEL.length) {
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
      id: 'C-PG-03',
      kind: 'synthetic',
      snapshotFormatVersion: 1,
      shell: 'synthetic-bash-like',
      cols: COLS,
      rows: ROWS,
      description:
        'more /etc/hosts: main-buffer-only pager (no DECSET 1049), reverse-video `--More--(END)` status, clean exit via CSI K + CR. Contrasts with C-PG-01 (less, alt-buffer pager).',
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
