#!/usr/bin/env node
/**
 * SYNTHETIC C-NET-02 fixture generator — interactive remote bash over
 * ssh, with `cd /etc` + `ls`.
 *
 * Plan 0005 P0 Gate #6. Hand-authored byte stream; real recording will
 * replace this once `tools/compat-record` lands.
 *
 * Scope: multi-turn SSH session (not one-shot like C-NET-01). Covers:
 *
 *   1. Local bash prompt + `ssh localhost` connect.
 *   2. Remote MOTD banner (Last login line).
 *   3. Remote prompt `user@host:/home/user$ `.
 *   4. `cd /etc` → new prompt reflects cwd as `/etc`.
 *   5. `ls` → short directory listing (5 well-known /etc entries).
 *   6. `exit` → local prompt returns.
 *
 * CWD-via-prompt-heuristic
 * ------------------------
 * We infer the remote cwd by *reading* the prompt (`:/home/user$` vs
 * `:/etc$`). This is a heuristic — real cwd reporting requires OSC 7,
 * which P1-SI will add. Once OSC 7 lands, this fixture will be upgraded
 * to assert authoritative cwd.
 *
 * Why synthetic?
 * --------------
 * Real ssh/sshd would add terminfo queries, DA queries, stty negotiation,
 * bracketed-paste advertisements, OSC 10/11 queries, etc. None of those
 * are load-bearing for the main-buffer transcript contract under test.
 *
 * NO alt-screen at any point (plain interactive shell, not tmux/nano).
 * NO SGR.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-NET-02/build-fixture.mjs
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
const COLS = 60;
const ROWS = 12;

// Invariant prompts / banner strings used in assertions.
const SSH_BANNER = 'Last login: Sat Jan  1 12:34:00 2022 from 127.0.0.1';
const REMOTE_PROMPT_HOME = 'user@host:/home/user$ ';
const REMOTE_PROMPT_ETC = 'user@host:/etc$ ';
const LS_OUTPUT = 'hosts  motd  passwd  resolv.conf  shadow';

// Row layout after full sequence:
//   row 0: `$ ssh localhost`
//   row 1: SSH_BANNER
//   row 2: `user@host:/home/user$ cd /etc`
//   row 3: `user@host:/etc$ ls`
//   row 4: LS_OUTPUT
//   row 5: `user@host:/etc$ exit`
//   row 6: `$ ` (local prompt, cursor parked at col 2)

// ---------- Build stream + checkpoints ----------
/** @type {number[]} */
const stream = [];
/** @type {Array<{at_byte_offset: number, description: string, expected: Record<string, unknown>}>} */
const checkpoints = [];

function appendChunk(chunk) {
  for (const b of chunk) stream.push(b);
  return stream.length;
}

function blankWidths() {
  return Array(COLS).fill(1);
}

// --- Phase 1: local prompt + ssh command ---
appendChunk(bytes('$ ssh localhost\r\n'));

// --- Phase 2: remote banner + initial prompt ---
appendChunk(bytes(SSH_BANNER, '\r\n'));
appendChunk(bytes(REMOTE_PROMPT_HOME));

// --- CP 1: remote MOTD + initial prompt visible ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After ssh connect + MOTD + initial remote prompt — row 0 has local ssh command, row 1 has the Last-login banner, row 2 holds the remote prompt (cwd=/home/user).',
  expected: {
    cursor: { row: 2, col: REMOTE_PROMPT_HOME.length },
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ ssh localhost', widths: blankWidths() },
      1: { text: SSH_BANNER, widths: blankWidths() },
      2: { text: REMOTE_PROMPT_HOME, widths: blankWidths() },
    },
  },
});

// --- CP 2: prompt reflects remote user@host form ---
// Same offset as CP 1 but with a narrower projection focused on the
// prompt shape. Keeps assertions surgical.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Prompt shape assertion: row 2 carries `user@host:/home/user$ ` (remote user@host heuristic). P1-SI will replace this with OSC 7 reads.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      2: { text: REMOTE_PROMPT_HOME, widths: blankWidths() },
    },
  },
});

// --- Phase 3: user types `cd /etc\r\n` — echo lands after the prompt ---
appendChunk(bytes('cd /etc\r\n'));
// Remote shell reprints the next prompt with the new cwd.
appendChunk(bytes(REMOTE_PROMPT_ETC));

// --- CP 3: after `cd /etc` the prompt shows `/etc` ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `cd /etc\\r\\n` + new prompt — row 2 shows the command echo on top of the previous prompt, row 3 holds the new `user@host:/etc$ ` prompt (cwd reflected).',
  expected: {
    cursor: { row: 3, col: REMOTE_PROMPT_ETC.length },
    mode: { altScreen: false },
    selected_rows: {
      2: {
        text: REMOTE_PROMPT_HOME + 'cd /etc',
        widths: blankWidths(),
      },
      3: { text: REMOTE_PROMPT_ETC, widths: blankWidths() },
    },
  },
});

// --- Phase 4: `ls\r\n` + multi-entry output + next prompt ---
appendChunk(bytes('ls\r\n'));
appendChunk(bytes(LS_OUTPUT, '\r\n'));
appendChunk(bytes(REMOTE_PROMPT_ETC));

// --- CP 4: `ls` output includes `passwd` ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After `ls\\r\\n` + 5-entry /etc listing — row 3 shows the command, row 4 holds the listing (includes `passwd`), row 5 holds the next prompt.',
  expected: {
    cursor: { row: 5, col: REMOTE_PROMPT_ETC.length },
    mode: { altScreen: false },
    selected_rows: {
      3: {
        text: REMOTE_PROMPT_ETC + 'ls',
        widths: blankWidths(),
      },
      4: { text: LS_OUTPUT, widths: blankWidths() },
      5: { text: REMOTE_PROMPT_ETC, widths: blankWidths() },
    },
  },
});

// --- Phase 5: `exit\r\n` returns to local prompt ---
appendChunk(bytes('exit\r\n'));
appendChunk(bytes('$ '));

// --- CP 5: altScreen stayed false; local prompt back ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After remote `exit\\r\\n` + local `$ ` reprint — local prompt on row 6, altScreen never flipped, and the whole transcript remains byte-exact on rows 0-6.',
  expected: {
    cursor: { row: 6, col: 2 },
    mode: { altScreen: false },
    scrollback: { rowCount: 0 },
    selected_rows: {
      5: {
        text: REMOTE_PROMPT_ETC + 'exit',
        widths: blankWidths(),
      },
      6: { text: '$ ', widths: blankWidths() },
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
      shell: 'synthetic-bash-ssh-interactive',
      cols: COLS,
      rows: ROWS,
      description:
        'Interactive remote bash over ssh: cd /etc + ls + exit. Tests multi-turn ssh transcript, cwd-via-prompt heuristic, and clean ssh disconnect back to local prompt. P1-SI will replace the prompt-match cwd check with an authoritative OSC 7 read.',
      authoredAt: '2026-04-21T00:00:00Z',
      kind: 'synthetic',
      id: 'C-NET-02',
      snapshotFormatVersion: 1,
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `wrote ${stream.length} bytes to input.bytes; ${checkpoints.length} checkpoints.`,
);
