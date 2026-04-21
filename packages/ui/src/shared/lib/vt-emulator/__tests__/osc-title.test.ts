/**
 * OSC title change — `OSC 0 ; title BEL`, `OSC 1 ; title BEL` (icon),
 * `OSC 2 ; title BEL` (window), with either BEL (0x07) or ST (ESC \)
 * as the terminator.
 *
 * CURRENT STATE (2026-04-21): the emulator does NOT emit a
 * `title_changed` event. The OSC dispatcher (`dispatchOsc` in
 * VtEmulator.ts) only acts on OSC 7 (cwd), OSC 10 (fg query) and OSC 11
 * (bg query). OSC 0 / 1 / 2 payloads are parsed to the terminator and
 * then dropped — `default: return;` in the switch.
 *
 * TODO (plan 0005 P1): add `onTitleChanged(kind, title)` to
 * `VtEmulatorOptions` where `kind` is `'window'` / `'icon'` / `'both'`.
 * Wire the dispatch branch.
 *
 * These tests lock the current passthrough contract:
 *   - The OSC payload is fully consumed (BEL- and ST-terminated forms).
 *   - Text after the terminator lands on the grid at the expected column.
 *   - Unknown OSC commands (OSC 99 etc.) are treated the same — consumed
 *     without side effects.
 *   - Malformed payloads (missing `;`) don't crash the FSM.
 *
 * When the `onTitleChanged` hook lands, each of these tests should flip
 * to a positive assertion on the received title string.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../VtEmulator.js';
import type {
  GridEventEnvelope,
  GridPayload,
} from '../../grid-mirror/types.js';

type Env = GridEventEnvelope<GridPayload>;

class Harness {
  readonly envs: Env[] = [];
  readonly emulator: VtEmulator;

  constructor(rows = 3, cols = 20) {
    this.emulator = new VtEmulator({
      sessionId: 'osc-title-test',
      rows,
      cols,
      onEnvelope: (env) => this.envs.push(env),
    });
  }

  feed(s: string | Uint8Array): void {
    const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : s;
    this.emulator.feed(bytes);
  }

  cellGrapheme(row: number, col: number): string {
    return this.emulator._getCell(row, col)?.grapheme ?? '';
  }
}

describe('osc-title — BEL-terminated payloads are consumed cleanly', () => {
  it('OSC 0 ; title BEL swallows the payload and resumes printing', () => {
    // Invariant: OSC 0 (icon+window title) is fully consumed; text after
    // the terminator prints at the cursor position.
    // TODO-P1: assert the host received the title string.
    const h = new Harness();
    h.feed('\x1b]0;my window title\x07ready');
    expect(h.cellGrapheme(0, 0)).toBe('r');
    expect(h.cellGrapheme(0, 4)).toBe('y');
    expect(h.emulator._getCursor().col).toBe(5);
  });

  it('OSC 2 ; title BEL (window-only) is consumed', () => {
    // Invariant: OSC 2 (window title) is not distinguished from OSC 0
    // today — both are dropped after parsing to the terminator.
    const h = new Harness();
    h.feed('\x1b]2;just window\x07X');
    expect(h.cellGrapheme(0, 0)).toBe('X');
    expect(h.emulator._getCursor().col).toBe(1);
  });

  it('OSC 1 ; title BEL (icon-only) is consumed', () => {
    // Invariant: OSC 1 (icon title) is consumed — no side effect on grid,
    // no crash.
    const h = new Harness();
    h.feed('\x1b]1;icon\x07Y');
    expect(h.cellGrapheme(0, 0)).toBe('Y');
    expect(h.emulator._getCursor().col).toBe(1);
  });
});

describe('osc-title — ST-terminated payloads are consumed cleanly', () => {
  it('OSC 0 ; title ESC \\\\ is consumed', () => {
    // Invariant: ST (ESC \) is an equally valid OSC terminator. Both
    // forms must work.
    const h = new Harness();
    h.feed('\x1b]0;window\x1b\\Z');
    expect(h.cellGrapheme(0, 0)).toBe('Z');
  });
});

describe('osc-title — malformed / edge payloads do not corrupt FSM', () => {
  it('OSC with no payload body (`ESC ] BEL`) is a no-op', () => {
    // Invariant: an empty OSC payload is dropped without reply. The FSM
    // returns to Ground so subsequent text prints normally.
    const h = new Harness();
    h.feed('\x1b]\x07Hi');
    expect(h.cellGrapheme(0, 0)).toBe('H');
    expect(h.cellGrapheme(0, 1)).toBe('i');
  });

  it('unknown OSC command (OSC 99 ; payload BEL) is dropped silently', () => {
    // Invariant: the dispatcher only acts on known commands; unknown
    // numerics fall through the `default: return;` path.
    const h = new Harness();
    h.feed('\x1b]99;whatever\x07Q');
    expect(h.cellGrapheme(0, 0)).toBe('Q');
  });
});
