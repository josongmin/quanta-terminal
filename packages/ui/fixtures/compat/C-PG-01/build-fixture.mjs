#!/usr/bin/env node
/**
 * SYNTHETIC C-PG-01 fixture generator — `less /etc/passwd`.
 *
 * Plan 0005 P0 Epic ε. This fixture is hand-authored (no live PTY
 * recording yet; `tools/compat-record` is still a stub per Plan 0005
 * Epic ε §6). The goal is to exercise less's documented DEC 1049
 * alt-screen lifecycle + scroll-repaint pattern using a byte stream
 * small enough that every byte is reviewable in `build-fixture.mjs`.
 *
 * Scenario
 * --------
 *   1. Shell prompt `$ less /etc/passwd\r\n` (main buffer).
 *   2. DECSET 1049h — enter alt buffer (engine clears implicitly).
 *   3. Home cursor + paint 23 lines of fake /etc/passwd onto rows 0..22.
 *   4. Reverse-video `:` on row 23 (less's waiting-for-command prompt).
 *   5. Simulated user presses `j` (scroll down by one): clear + repaint,
 *      this time starting at the 2nd entry so row 0 is NO LONGER `root`.
 *   6. Simulated user presses `G` (jump to end): clear + repaint last
 *      entries; status line shows `(END)` in reverse video.
 *   7. DECSET 1049l — exit alt buffer. Main buffer must restore with
 *      `$ less /etc/passwd` intact at row 0; alt content gone.
 *   8. Shell reprints `$ ` on the main buffer.
 *
 * Why synthetic?
 *   - Real `less` output varies with termcap negotiation (±500 bytes of
 *     SGR setup), screen-size assumptions, and locale.
 *   - The emulator contract under test is alt-buffer swap + clear +
 *     cursor-position restore. Those paths don't care whether the
 *     content bytes came from real less or a faithful hand-stream.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-PG-01/build-fixture.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ESC = 0x1b;
const CSI = [ESC, 0x5b]; // ESC [
const enc = new TextEncoder();

/** Concatenate a mix of `number`, `number[]`, and strings into bytes. */
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
// Standard less default window — 80 cols, 24 rows.
const COLS = 80;
const ROWS = 24;

// 24 synthetic /etc/passwd lines. Keep them <= COLS graphemes and keep
// content simple so the projection is readable in checkpoints.
const PASSWD_LINES = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'bin:x:2:2:bin:/bin:/usr/sbin/nologin',
  'sys:x:3:3:sys:/dev:/usr/sbin/nologin',
  'sync:x:4:65534:sync:/bin:/bin/sync',
  'games:x:5:60:games:/usr/games:/usr/sbin/nologin',
  'man:x:6:12:man:/var/cache/man:/usr/sbin/nologin',
  'lp:x:7:7:lp:/var/spool/lpd:/usr/sbin/nologin',
  'mail:x:8:8:mail:/var/mail:/usr/sbin/nologin',
  'news:x:9:9:news:/var/spool/news:/usr/sbin/nologin',
  'uucp:x:10:10:uucp:/var/spool/uucp:/usr/sbin/nologin',
  'proxy:x:13:13:proxy:/bin:/usr/sbin/nologin',
  'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin',
  'backup:x:34:34:backup:/var/backups:/usr/sbin/nologin',
  'list:x:38:38:Mailing List Manager:/var/list:/usr/sbin/nologin',
  'irc:x:39:39:ircd:/var/run/ircd:/usr/sbin/nologin',
  'gnats:x:41:41:Gnats Bug-Reporting:/var/lib/gnats:/usr/sbin/nologin',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
  'systemd-network:x:100:102:systemd Network:/run/systemd:/usr/sbin/nologin',
  'systemd-resolve:x:101:103:systemd Resolver:/run/systemd:/usr/sbin/nologin',
  'messagebus:x:102:105::/nonexistent:/usr/sbin/nologin',
  'syslog:x:103:109::/home/syslog:/usr/sbin/nologin',
  '_apt:x:104:65534::/nonexistent:/usr/sbin/nologin',
  'tss:x:105:111:TPM software stack:/var/lib/tpm:/bin/false',
];

// Phase 1: Main-buffer prompt + command.
const phase1 = bytes('$ less /etc/passwd\r\n');

// Phase 2: Enter alt-screen. The engine clears on entry; we also send
// CSI H to place the cursor at the home position deterministically.
const enter1049 = bytes(...CSI, '?1049h');
const cursorHome = bytes(...CSI, 'H');

/**
 * Paint `lines` onto rows 0..N-1 using CSI H-style absolute moves so the
 * stream is robust against scroll/wrap quirks. Lines are truncated to
 * COLS graphemes. Returns the byte array.
 *
 * Intentionally uses CSI <r>;1H for each line rather than `\r\n` —
 * `\r\n` semantics change based on LNM / scroll region and would muddy
 * the fixture's intent.
 */
function paintLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const row1 = i + 1; // CSI is 1-indexed.
    out.push(...bytes(...CSI, `${row1};1H`));
    const text = lines[i].slice(0, COLS);
    out.push(...bytes(text));
  }
  return out;
}

/**
 * Clear + home, then paint a status row on the last screen row in
 * reverse video. `label` is typically `:` (waiting prompt) or `(END)`.
 */
function paintStatus(label) {
  return bytes(
    ...CSI,
    `${ROWS};1H`,
    ...CSI,
    '7m', // inverse on
    label,
    ...CSI,
    '0m', // reset
  );
}

/** CSI 2J — erase entire display. Used before each less repaint frame. */
const eraseDisplay = bytes(...CSI, '2J');

// --- Frame 1: initial paint (rows 0..22 of passwd, status `:` on 23) ---
// We fill rows 0..ROWS-2 (23 content rows); row ROWS-1 is the status.
const frame1Content = paintLines(PASSWD_LINES.slice(0, ROWS - 1));
const frame1Status = paintStatus(':');

// --- Frame 2: scroll-down repaint. `j` scrolls by one line in less. ---
// Real less repaints the shifted window; we emulate that by erasing and
// repainting rows 0..ROWS-2 starting at the 2nd entry so `root:` is
// gone from row 0.
const frame2Content = paintLines(PASSWD_LINES.slice(1, ROWS));
const frame2Status = paintStatus(':');

// --- Frame 3: jump-to-end (`G`). Last ROWS-1 content entries; the
// status switches to `(END)`. Since PASSWD_LINES has exactly ROWS
// entries, slicing .slice(1, ROWS) covers the final 23 rows.
const frame3Content = paintLines(PASSWD_LINES.slice(1, ROWS));
const frame3Status = paintStatus('(END)');

// Phase 7: exit alt; phase 8: post-exit prompt (no CR/LF — matches the
// C-ED-01 convention where cursor returns to its pre-entry row, then
// the shell repaints `$ ` in place).
const exit1049 = bytes(...CSI, '?1049l');
const postPrompt = bytes('$ ');

// ---------- Assemble + record checkpoints ----------
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

// --- CP 1: after DECSET 1049h + cursor home ---
// Prompt written → alt entered → clear + cursor home. Alt grid is blank.
appendChunk(phase1);
appendChunk(enter1049);
appendChunk(cursorHome);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After shell prints prompt + DECSET 1049h + CSI H — alt buffer active, grid cleared, cursor at origin.',
  expected: {
    cursor: { row: 0, col: 0 },
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '', widths: Array(COLS).fill(1) },
      1: { text: '', widths: Array(COLS).fill(1) },
      23: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 2: after frame 1 paint — row 0 contains `root:x:0:0:...` ---
appendChunk(frame1Content);
appendChunk(frame1Status);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After less frame 1 paint — passwd rows filled, row 0 is `root:`, status row reads `:`.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: {
        text: PASSWD_LINES[0],
        widths: Array(COLS).fill(1),
      },
      // Row 23 is the status line. `paintStatus` wrote `:` in reverse;
      // the projection only captures text (not SGR) unless sgrDigest is
      // requested — `:` is the only printable grapheme so that's what
      // shows in `.text`.
      23: {
        text: ':',
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- CP 3: after scroll-down repaint — row 0 no longer `root:` ---
// Real less would also send a `CSI 2J` before repainting; we do the
// same so the exiting frame's pixels don't bleed into frame 2.
appendChunk(eraseDisplay);
appendChunk(frame2Content);
appendChunk(frame2Status);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `j` scroll-down repaint — row 0 now `daemon:` (not `root:`); still in alt buffer.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: {
        text: PASSWD_LINES[1],
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- CP 4: after `G` jump-to-end repaint — status line shows `(END)` ---
appendChunk(eraseDisplay);
appendChunk(frame3Content);
appendChunk(frame3Status);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `G` jump-to-end — status line now reads `(END)`; row 0 shows `daemon:`.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: {
        text: PASSWD_LINES[1],
        widths: Array(COLS).fill(1),
      },
      23: {
        text: '(END)',
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// --- CP 5: after DECSET 1049l — main buffer restored ---
// Before entering alt, main buffer row 0 was `$ less /etc/passwd` and
// the cursor sat on row 1 col 0. The xterm 1049 save/restore contract
// must bring us right back there.
appendChunk(exit1049);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After DECSET 1049l — main buffer restored; alt content discarded; cursor back at pre-1049h position.',
  expected: {
    cursor: { row: 1, col: 0 },
    mode: { altScreen: false },
    selected_rows: {
      0: {
        text: '$ less /etc/passwd',
        widths: Array(COLS).fill(1),
      },
      1: { text: '', widths: Array(COLS).fill(1) },
      23: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// --- CP 6: after shell reprints `$ ` on the restored main buffer ---
appendChunk(postPrompt);
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After post-exit `$ ` — cursor lands at row 1 col 2, main buffer shows the new prompt.',
  expected: {
    cursor: { row: 1, col: 2 },
    mode: { altScreen: false },
    selected_rows: {
      // Trailing space is preserved in the projection — `$ ` writes two
      // cells (`$` then ` `), and both have non-empty graphemes, so
      // `projectRow` keeps them. Matches C-ED-01's CP5 convention.
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
        'less /etc/passwd: DECSET 1049h → initial paint → scroll-down repaint → jump-to-end `(END)` → DECSET 1049l → main buffer restored.',
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
