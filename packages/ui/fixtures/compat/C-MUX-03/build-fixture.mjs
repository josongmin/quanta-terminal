#!/usr/bin/env node
/**
 * SYNTHETIC C-MUX-03 fixture generator — tmux-in-ssh-in-tmux (depth 3).
 *
 * Plan 0005 P0 Gate #6. Triple nesting:
 *   local bash → tmux → ssh localhost → remote shell → tmux.
 *
 * This is the stress test for alt-screen state under nested programs
 * that each want to own the alt buffer. Our emulator has ONE alt
 * buffer, not a stack — so:
 *
 *   - Outer 1049h enters alt (alt_screen: false → true).
 *   - Inner 1049h is a no-op (already alt).
 *   - Inner 1049l exits alt (alt_screen: true → false).
 *   - At that point the main buffer shows whatever was there BEFORE the
 *     outer tmux entered alt — NOT the outer tmux's display. Real xterm
 *     has the same behaviour; tmux / screen get around it by talking
 *     to a "virtual terminal" they maintain internally.
 *
 * Load-bearing invariants (the "engine contract")
 * -----------------------------------------------
 *   CP 1: outer 1049h → altScreen=true.
 *   CP 2: remote login banner painted inside the outer alt buffer.
 *   CP 3: inner 1049h → altScreen=true (still true, no toggle).
 *   CP 4: inner 1049l → altScreen=false.
 *   CP 5: main buffer shows the pre-outer-tmux state (`$ tmux`), not
 *         the outer tmux's last paint. This matches the "no buffer
 *         stack" contract; P1 ModeStack work will add a real stack
 *         later.
 *
 * Scenario
 * --------
 *   1. Local `$ tmux\r\n`.
 *   2. DECSET 1049h (outer tmux).
 *   3. Outer tmux paints status line + `$ ` prompt.
 *   4. `ssh localhost\r\n`.
 *   5. `Last login: ...\r\n` + remote `$ `.
 *   6. Remote `tmux\r\n`.
 *   7. DECSET 1049h (inner tmux — no-op per the contract).
 *   8. Inner tmux paints status line + `$ ` prompt (in same alt buffer;
 *      overwrites outer tmux's paint).
 *   9. Inner `echo hello\r\nhello\r\n$ `.
 *   10. Inner `exit\r\n` → DECSET 1049l.
 *   11. Main buffer is now shown; it holds the pre-outer-tmux content.
 *
 * Re-run with:
 *   node packages/ui/fixtures/compat/C-MUX-03/build-fixture.mjs
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
const COLS = 60;
const ROWS = 10;
const STATUS_ROW = ROWS - 1;

const OUTER_STATUS = '[outer] 0:bash*';
const INNER_STATUS = '[inner] 0:zsh*';
const SSH_BANNER = 'Last login: Sat Jan  1 12:34:00 2022 from 127.0.0.1';

function paintAt(row1, col1, text) {
  return bytes(...CSI, `${row1};${col1}H`, text);
}

function paintStatus(label) {
  return bytes(
    ...CSI, `${STATUS_ROW + 1};1H`,
    ...CSI, '7m', label,
    ...CSI, '0m',
  );
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

// Phase 1: local `$ tmux\r\n`.
appendChunk(bytes('$ tmux\r\n'));

// Phase 2: outer tmux enters alt + clear + home.
appendChunk(bytes(...CSI, '?1049h'));
appendChunk(bytes(...CSI, '2J'));
appendChunk(bytes(...CSI, 'H'));

// --- CP 1: outer alt enter ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'After outer tmux DECSET 1049h + clear + home — alt buffer active; scrollback still zero.',
  expected: {
    cursor: { row: 0, col: 0 },
    mode: { altScreen: true },
    scrollback: { rowCount: 0 },
    selected_rows: {
      0: { text: '', widths: Array(COLS).fill(1) },
    },
  },
});

// Phase 3: outer tmux paints status + `$ ` prompt inside alt.
appendChunk(paintAt(1, 1, '$ '));
appendChunk(paintStatus(OUTER_STATUS));

// Phase 4: user runs `ssh localhost` in outer tmux.
// Over-paint the prompt with the command.
appendChunk(paintAt(1, 1, '$ ssh localhost'));
appendChunk(bytes('\r\n'));
appendChunk(bytes(SSH_BANNER, '\r\n'));
appendChunk(bytes('$ '));

// --- CP 2: remote login in outer alt ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Remote ssh banner painted inside the outer tmux alt buffer. Row 0 holds the ssh command, row 1 the banner, row 2 the remote prompt.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '$ ssh localhost', widths: Array(COLS).fill(1) },
      1: { text: SSH_BANNER, widths: Array(COLS).fill(1) },
      2: { text: '$ ', widths: Array(COLS).fill(1) },
      [STATUS_ROW]: {
        text: OUTER_STATUS,
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// Phase 5: remote `tmux\r\n`.
appendChunk(bytes('tmux\r\n'));

// Phase 6: inner tmux DECSET 1049h — no-op per engine contract. Still
// emit 2J + H so inner tmux's paint is on a clean visible grid.
appendChunk(bytes(...CSI, '?1049h'));
appendChunk(bytes(...CSI, '2J'));
appendChunk(bytes(...CSI, 'H'));

// Inner tmux paints status + `$ ` prompt.
appendChunk(paintAt(1, 1, '$ '));
appendChunk(paintStatus(INNER_STATUS));

// --- CP 3: inner tmux enter (still alt === true, no toggle) ---
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Inner tmux DECSET 1049h inside already-alt buffer. Engine treats as no-op (no nested buffer stack). altScreen remains true. Inner paint overwrites outer: row 0 is the fresh `$ ` prompt; status line now shows the inner label.',
  expected: {
    mode: { altScreen: true },
    selected_rows: {
      0: { text: '$ ', widths: Array(COLS).fill(1) },
      [STATUS_ROW]: {
        text: INNER_STATUS,
        widths: Array(COLS).fill(1),
      },
    },
  },
});

// Phase 7: inner echo hello.
appendChunk(paintAt(1, 1, '$ echo hello'));
appendChunk(bytes('\r\n'));
appendChunk(bytes('hello\r\n'));
appendChunk(bytes('$ '));

// Phase 8: inner `exit\r\n` → inner tmux exits → DECSET 1049l.
appendChunk(bytes(...CSI, '?1049l'));

// --- CP 4: inner tmux 1049l → alt === false ---
// Engine contract: one alt buffer; 1049l exits regardless of nesting.
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Inner tmux DECSET 1049l. Engine exits alt unconditionally (no nested stack). altScreen=false.',
  expected: {
    mode: { altScreen: false },
  },
});

// --- CP 5: main buffer shows the pre-outer-tmux content ($  tmux <enter>), NOT outer tmux's display. ---
// After 1049l we are back in MAIN buffer — what was there before we
// ever entered alt: just row 0 `$ tmux`. (There was no reprompt yet
// because this is an abrupt exit from alt with no trailing shell
// prompt on main.)
checkpoints.push({
  at_byte_offset: stream.length,
  description:
    'Main buffer now restored to its pre-outer-tmux state: row 0 holds `$ tmux`, row 1 is empty. Outer tmux\'s display is NOT preserved — confirms the "no alt-buffer stack" engine contract.',
  expected: {
    mode: { altScreen: false },
    selected_rows: {
      0: { text: '$ tmux', widths: Array(COLS).fill(1) },
      1: { text: '', widths: Array(COLS).fill(1) },
      [STATUS_ROW]: { text: '', widths: Array(COLS).fill(1) },
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
        'tmux-in-ssh-in-tmux (depth 3): outer tmux enters alt, ssh to localhost, inner tmux 1049h is a no-op, inner 1049l exits alt unconditionally. Documents the engine\'s "no alt-buffer stack" contract — P1 ModeStack work will refine.',
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
