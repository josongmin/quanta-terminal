/**
 * Charset switching audit — `ESC ( B`, `ESC ( 0`, `SI` (0x0F), `SO` (0x0E),
 * `ESC ) 0`, etc. Covers the G0/G1 designator slots and shift-in / shift-out
 * controls.
 *
 * CURRENT STATE (2026-04-21): the emulator does NOT implement charset swap.
 * `stepEscape` consumes the two-byte `ESC ( <designator>` (and `) * +`)
 * sequences via `pendingCharsetSkip` (the designator byte is discarded in
 * the feed() top-level loop). SI (0x0F) and SO (0x0E) are ignored in
 * `stepGround` (they fall through the `default` branch — see comment
 * "Other C0 controls (SO/SI/SUB/CAN/etc.) are ignored for our scope.").
 *
 * Net effect on a real app stream: apps that toggle into DEC Special
 * Graphics (line-drawing) via `ESC ( 0` followed by `lqk` get raw ASCII
 * `lqk` on the grid, NOT `┌─┐`. This is a known limitation; TUIs that
 * depend on box-drawing (vim border frames, tmux status bars, mc panels)
 * render as ASCII noise in those cells. Fixing this requires:
 *   1. A G0/G1 state pair + active-set pointer.
 *   2. Wiring SI/SO in `stepGround`.
 *   3. A DEC Special Graphics translation table (0x60..0x7e → line-drawing
 *      code points).
 *   4. Applying the translation in `printGrapheme` before calling the
 *      width classifier.
 *
 * TODO (plan 0005 P1): implement the translation table + G0/G1 state and
 * replace these "current behaviour" tests with positive assertions that
 * `lqk` under DEC Special Graphics renders as `┌─┐`.
 *
 * For now these tests lock the *passthrough* contract: designator consumes
 * exactly one byte, SI/SO don't corrupt the cursor, arbitrary characters
 * after a supposed-charset-swap still land as their raw Unicode codepoints.
 * That way if someone naively adds charset handling without the full
 * state machine, the regression is caught.
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

  constructor(rows = 4, cols = 10) {
    this.emulator = new VtEmulator({
      sessionId: 'charset-test',
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

describe('charset-switching — designator consumption', () => {
  it('ESC ( B consumes exactly one byte then resumes printing', () => {
    // Invariant: `ESC ( B` is a two-byte sequence; the `B` designator is
    // swallowed, subsequent text lands on the grid.
    const h = new Harness();
    h.feed('\x1b(BHello');
    expect(h.cellGrapheme(0, 0)).toBe('H');
    expect(h.cellGrapheme(0, 4)).toBe('o');
  });

  it('ESC ( 0 consumes the designator — plain ASCII follows (current behaviour)', () => {
    // Invariant (current): `ESC ( 0` enters DEC Special Graphics in a real
    // terminal. We currently DROP the designator and print subsequent bytes
    // as raw ASCII. TODO: implement translation so `lqk` → `┌─┐`.
    const h = new Harness();
    h.feed('\x1b(0lqk');
    expect(h.cellGrapheme(0, 0)).toBe('l');
    expect(h.cellGrapheme(0, 1)).toBe('q');
    expect(h.cellGrapheme(0, 2)).toBe('k');
    // FIXME-P1: once DEC Special Graphics is wired, assert '┌', '─', '┐'.
  });

  it('ESC ) 0 consumes one byte then prints — G1 designator ignored (current behaviour)', () => {
    // Invariant: the G1 designator `ESC ) 0` is parsed as two bytes and
    // dropped. Subsequent text prints unaltered.
    const h = new Harness();
    h.feed('\x1b)0xyz');
    expect(h.cellGrapheme(0, 0)).toBe('x');
    expect(h.cellGrapheme(0, 1)).toBe('y');
    expect(h.cellGrapheme(0, 2)).toBe('z');
  });

  it('ESC ( <LF> as designator — LF is consumed as the designator byte, no crash', () => {
    // Invariant: a control byte immediately after `ESC (` is still
    // consumed as the (invalid) designator. The emulator must not treat it
    // as a line-feed. Subsequent printable lands at the original position.
    const h = new Harness();
    h.feed('\x1b(\nHi');
    // Cursor was at (0,0); the LF was eaten as the designator, so 'H' is
    // at (0,0), NOT shifted down to row 1.
    expect(h.cellGrapheme(0, 0)).toBe('H');
    expect(h.cellGrapheme(0, 1)).toBe('i');
    expect(h.cellGrapheme(1, 0)).toBe('');
  });
});

describe('charset-switching — SI / SO passthrough (current behaviour)', () => {
  it('SO (0x0E) is ignored — does not advance cursor or print (current behaviour)', () => {
    // Invariant (current): SO is silently dropped in Ground. TODO: wire it
    // to "select G1 as active set". For now we just assert nothing bad
    // happens: no phantom cell, cursor stays put.
    const h = new Harness();
    h.feed('A\x0eB');
    expect(h.cellGrapheme(0, 0)).toBe('A');
    // 'B' follows directly after the ignored SO.
    expect(h.cellGrapheme(0, 1)).toBe('B');
    expect(h.emulator._getCursor().col).toBe(2);
  });

  it('SI (0x0F) is ignored — does not advance cursor or print (current behaviour)', () => {
    // Invariant (current): SI is silently dropped in Ground. TODO: wire it
    // to "select G0 as active set". See SO note above.
    const h = new Harness();
    h.feed('A\x0fB');
    expect(h.cellGrapheme(0, 0)).toBe('A');
    expect(h.cellGrapheme(0, 1)).toBe('B');
    expect(h.emulator._getCursor().col).toBe(2);
  });

  it('SO / SI interleaved with printable is lossless passthrough', () => {
    // Invariant: a sequence like `A SO B SI C` must produce 'ABC' on the
    // grid under current (no-op charset) semantics. Once charset support
    // lands, the `B` should be sourced from G1 — but width/grapheme-count
    // stays the same.
    const h = new Harness();
    h.feed('A\x0eB\x0fC');
    expect(h.cellGrapheme(0, 0)).toBe('A');
    expect(h.cellGrapheme(0, 1)).toBe('B');
    expect(h.cellGrapheme(0, 2)).toBe('C');
  });

  it('ESC ( 0 followed by SO still prints raw ASCII (current behaviour)', () => {
    // Invariant (current): even the combined `designate G0 = DEC Special
    // Graphics; shift-out to G1` pattern that some apps emit when G1 is
    // also set to DEC Special Graphics is passthrough. This test locks
    // the current behaviour so a partial implementation (designator-only,
    // no SI/SO) doesn't regress into half-translated output.
    const h = new Harness();
    h.feed('\x1b(0\x0elqk');
    expect(h.cellGrapheme(0, 0)).toBe('l');
    expect(h.cellGrapheme(0, 1)).toBe('q');
    expect(h.cellGrapheme(0, 2)).toBe('k');
  });
});

describe('charset-switching — designator edge cases', () => {
  it('ESC ( B in the middle of text does not corrupt preceding cells', () => {
    // Invariant: an in-stream charset designation leaves already-printed
    // cells untouched.
    const h = new Harness();
    h.feed('Hi\x1b(BYo');
    expect(h.cellGrapheme(0, 0)).toBe('H');
    expect(h.cellGrapheme(0, 1)).toBe('i');
    expect(h.cellGrapheme(0, 2)).toBe('Y');
    expect(h.cellGrapheme(0, 3)).toBe('o');
  });

  it('ESC ( (partial) across feed() boundary — designator on next chunk', () => {
    // Invariant: `pendingCharsetSkip` survives across feed() calls. The
    // next byte — whatever it is — is consumed as the designator.
    const h = new Harness();
    h.feed('\x1b(');
    h.feed('0Hi');
    // '0' is the designator (DEC Special Graphics). 'Hi' is current-behaviour
    // raw ASCII.
    expect(h.cellGrapheme(0, 0)).toBe('H');
    expect(h.cellGrapheme(0, 1)).toBe('i');
  });
});
