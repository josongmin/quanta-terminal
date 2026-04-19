/**
 * **E2E — mouse tracking full loop**
 *
 * Covers the DOM pointer/wheel → `input-host` → `MouseEncoder` → `onBytesOut`
 * pipeline. Scenarios mirror the TUI-app expectations: vim/tmux/htop clicks
 * land as SGR 1006 sequences (ESC [ < Cb ; Col ; Row M|m), press/release
 * share a button code but differ by terminator, drag has +32 added to the
 * base button, wheel up/down are 64/65, and modifiers OR in +4/+8/+16.
 *
 * Implementation notes discovered while writing these tests:
 *   - Supported tracking modes: 'off' | 'x10' | 'button_event' | 'any_event'.
 *     (No separate 1002-only "drag" mode in this codebase; `button_event`
 *     covers DECSET 1000 + 1002 — drag is permitted, only "hover with no
 *     button" is gated out by `button_event`.)
 *   - Supported wire encodings: 'sgr' (1006) and 'default' (treated as SGR
 *     pre-negotiation). URXVT 1015 + legacy X10 on-the-wire are NOT wired.
 *   - xCell/yCell are 0-based in the encoder input; the encoder adds 1 to
 *     both before emitting (SGR 1006 is 1-based).
 *   - `modifiers.alt OR meta` collapses to the +8 "Meta" bit.
 *   - Off-tracking wheel emits zero bytes on the wire: xterm treats
 *     wheel as a mouse-tracking-only event, and input-host does not
 *     preventDefault so the browser's native scroll handles it.
 *   - Negative cell coords (click outside the grid) clamp to wire 1
 *     (xterm SGR 1006 is 1-based with a minimum of 1). Upper bound is
 *     enforced by the caller via `screenToCell`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Focus } from '../../features/input/Focus.js';
import { KeyEncoder } from '../../features/input/KeyEncoder.js';
import { MouseEncoder } from '../../features/input/MouseEncoder.js';
import { Paste } from '../../features/input/Paste.js';
import {
  createStubMirror,
  ModeSnapshot,
} from '../../features/input/ModeSnapshot.js';
import { mount } from '../../features/input/input-host.js';

const CELL_W = 10;
const CELL_H = 20;

interface MouseHarness {
  container: HTMLElement;
  handle: ReturnType<typeof mount>;
  bytesOut: Uint8Array[];
  mirror: ReturnType<typeof createStubMirror>;
}

/**
 * Build a harness with a real input-host attached. `screenToCell` divides
 * by fixed cell metrics so tests can drive (clientX, clientY) and reason
 * about cell coords directly. `getBoundingClientRect` is patched so the
 * container's origin is (0, 0) regardless of jsdom layout state.
 */
function makeHarness(
  init: Parameters<typeof createStubMirror>[0] = {},
): MouseHarness {
  const mirror = createStubMirror(init);
  const modeSnapshot = new ModeSnapshot(mirror);
  const keyEncoder = new KeyEncoder({ modeSnapshot });
  const mouseEncoder = new MouseEncoder({ modeSnapshot });
  const paste = new Paste({ modeSnapshot });
  const focus = new Focus({ modeSnapshot });

  const bytesOut: Uint8Array[] = [];

  const container = document.createElement('div');
  container.setAttribute('tabindex', '0');
  document.body.appendChild(container);

  const screenToCell = (clientX: number, clientY: number) => {
    // Deterministic, unclamped converter — tests that cover off-screen
    // clicks pass negative or large coords and assert the raw floor.
    const xCell = Math.floor(clientX / CELL_W);
    const yCell = Math.floor(clientY / CELL_H);
    return { xCell, yCell };
  };

  const handle = mount(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform: 'linux',
    screenToCell,
    onBytesOut: (b) => bytesOut.push(b),
  });

  return { container, handle, bytesOut, mirror };
}

/** Concatenate recorded byte chunks into a single Uint8Array. */
function flatten(buffers: readonly Uint8Array[]): Uint8Array {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/** Convert a recorded byte stream to an ASCII/escape-literal string. */
function asText(buffers: readonly Uint8Array[]): string {
  return new TextDecoder('utf-8').decode(flatten(buffers));
}

/**
 * Dispatch a PointerEvent-like synthetic DOM event. jsdom implements
 * PointerEvent as a thin shim; `pointerType`/`clientX`/`clientY`/`button`
 * etc. are forwarded by constructor init. We fall back to a MouseEvent
 * labelled 'pointerdown' if the environment lacks PointerEvent.
 */
function dispatchPointer(
  el: HTMLElement,
  type: 'pointerdown' | 'pointerup' | 'pointermove',
  init: {
    clientX: number;
    clientY: number;
    button?: number;
    buttons?: number;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  },
): void {
  const Ctor: typeof MouseEvent =
    (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ??
    MouseEvent;
  const ev = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
}

/**
 * Dispatch a WheelEvent. jsdom supports WheelEvent; we populate `deltaY`
 * (negative = up) and optional modifiers.
 */
function dispatchWheel(
  el: HTMLElement,
  init: {
    clientX: number;
    clientY: number;
    deltaY: number;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  },
): void {
  const ev = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  el.dispatchEvent(ev);
}

describe('mouse tracking e2e', () => {
  let harness: MouseHarness;

  afterEach(() => {
    harness.handle.unmount();
    harness.container.remove();
  });

  // -------------------------------------------------------------- modes off
  describe('mouse tracking off', () => {
    beforeEach(() => {
      harness = makeHarness(); // defaults: mouseTracking='off'
    });

    it('pointerdown with tracking=off emits no bytes', () => {
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 50,
        clientY: 40,
        button: 0,
      });
      expect(harness.bytesOut).toHaveLength(0);
    });

    it('pointerup with tracking=off emits no bytes', () => {
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 50,
        clientY: 40,
        button: 0,
      });
      dispatchPointer(harness.container, 'pointerup', {
        clientX: 50,
        clientY: 40,
        button: 0,
      });
      expect(harness.bytesOut).toHaveLength(0);
    });
  });

  // ------------------------------------------------------ SGR 1006 (modern)
  describe('SGR 1006 encoding (button_event / any_event)', () => {
    beforeEach(() => {
      harness = makeHarness({
        mouseTracking: 'button_event',
        mouseEncoding: 'sgr',
      });
    });

    it('left click at cell (5, 3) → ESC [ < 0 ; 6 ; 4 M (1-indexed press)', () => {
      // clientX=55 / 10 = 5; clientY=60 / 20 = 3.
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 55,
        clientY: 60,
        button: 0,
      });
      expect(harness.bytesOut).toHaveLength(1);
      expect(asText(harness.bytesOut)).toBe('\u001b[<0;6;4M');
    });

    it('left release at (5, 3) → ESC [ < 0 ; 6 ; 4 m', () => {
      dispatchPointer(harness.container, 'pointerup', {
        clientX: 55,
        clientY: 60,
        button: 0,
      });
      expect(harness.bytesOut).toHaveLength(1);
      expect(asText(harness.bytesOut)).toBe('\u001b[<0;6;4m');
    });

    it('right click → Cb=2; middle click → Cb=1', () => {
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 0,
        clientY: 0,
        button: 2,
      });
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 0,
        clientY: 0,
        button: 1,
      });
      expect(harness.bytesOut).toHaveLength(2);
      expect(asText([harness.bytesOut[0]!])).toBe('\u001b[<2;1;1M');
      expect(asText([harness.bytesOut[1]!])).toBe('\u001b[<1;1;1M');
    });

    it('wheel up → Cb=64; wheel down → Cb=65 (with tracking on)', () => {
      // deltaY < 0 is "up" in the input-host convention.
      dispatchWheel(harness.container, {
        clientX: 20,
        clientY: 20,
        deltaY: -10,
      });
      dispatchWheel(harness.container, {
        clientX: 20,
        clientY: 20,
        deltaY: 10,
      });
      expect(harness.bytesOut).toHaveLength(2);
      // (20/10, 20/20) = (2, 1) → cols+1=3, rows+1=2
      expect(asText([harness.bytesOut[0]!])).toBe('\u001b[<64;3;2M');
      expect(asText([harness.bytesOut[1]!])).toBe('\u001b[<65;3;2M');
    });

    it('Ctrl+left click → Cb = 0 | 16 = 16', () => {
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 0,
        clientY: 0,
        button: 0,
        ctrlKey: true,
      });
      expect(asText(harness.bytesOut)).toBe('\u001b[<16;1;1M');
    });

    it('Shift+left click → Cb = 0 | 4 = 4', () => {
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 0,
        clientY: 0,
        button: 0,
        shiftKey: true,
      });
      expect(asText(harness.bytesOut)).toBe('\u001b[<4;1;1M');
    });

    it('Alt+left click → Cb = 0 | 8 = 8 (meta collapses into alt bit)', () => {
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 0,
        clientY: 0,
        button: 0,
        altKey: true,
      });
      expect(asText(harness.bytesOut)).toBe('\u001b[<8;1;1M');
    });

    it('Ctrl+Shift+Alt+left click → Cb = 0 | 4 | 8 | 16 = 28', () => {
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 0,
        clientY: 0,
        button: 0,
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
      });
      expect(asText(harness.bytesOut)).toBe('\u001b[<28;1;1M');
    });

    it('drag (buttons>0 on pointermove) → Cb = 32 + base button', () => {
      // pointerdown button=0 then pointermove with buttons=1 → drag.
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 0,
        clientY: 0,
        button: 0,
        buttons: 1,
      });
      dispatchPointer(harness.container, 'pointermove', {
        clientX: 30,
        clientY: 20,
        button: 0,
        buttons: 1,
      });
      expect(harness.bytesOut).toHaveLength(2);
      expect(asText([harness.bytesOut[0]!])).toBe('\u001b[<0;1;1M'); // press
      // drag: 32 + 0 = 32 at cell (3, 1) → (4, 2) on the wire
      expect(asText([harness.bytesOut[1]!])).toBe('\u001b[<32;4;2M');
    });

    it('hover with no button held (button_event mode) emits no bytes', () => {
      // `button_event` gates out hover-move. `any_event` would allow it.
      dispatchPointer(harness.container, 'pointermove', {
        clientX: 10,
        clientY: 10,
        button: -1,
        buttons: 0,
      });
      expect(harness.bytesOut).toHaveLength(0);
    });

    it('hover with no button held (any_event mode) → Cb=35 (32+3)', () => {
      // Swap modes mid-test via the mirror (bump epoch).
      harness.mirror.applyMode({ mouseTracking: 'any_event' });
      dispatchPointer(harness.container, 'pointermove', {
        clientX: 10,
        clientY: 10,
        button: -1,
        buttons: 0,
      });
      expect(harness.bytesOut).toHaveLength(1);
      expect(asText(harness.bytesOut)).toBe('\u001b[<35;2;1M');
    });
  });

  // -------------------------------------------------------------- x10 mode
  describe('x10 mode (press only)', () => {
    beforeEach(() => {
      harness = makeHarness({
        mouseTracking: 'x10',
        mouseEncoding: 'sgr',
      });
    });

    it('press emits an SGR press; release is gated out', () => {
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 20,
        clientY: 20,
        button: 0,
      });
      dispatchPointer(harness.container, 'pointerup', {
        clientX: 20,
        clientY: 20,
        button: 0,
      });
      expect(harness.bytesOut).toHaveLength(1);
      expect(asText(harness.bytesOut)).toBe('\u001b[<0;3;2M');
    });
  });

  // -------------------------------------------------------------- off-screen
  describe('coordinate handling', () => {
    beforeEach(() => {
      harness = makeHarness({
        mouseTracking: 'button_event',
        mouseEncoding: 'sgr',
      });
    });

    it('clamps negative cell coords to wire (1,1) per xterm SGR 1006', () => {
      // clientX=-5 → cell xCell=-1; encoder clamps negative coords to 0
      // before the +1 so the wire value bottoms out at 1 (xterm's
      // minimum). Upper bound is input-host's screenToCell concern.
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: -5,
        clientY: 0,
        button: 0,
      });
      expect(harness.bytesOut).toHaveLength(1);
      expect(asText(harness.bytesOut)).toBe('\u001b[<0;1;1M');
    });

    it('clamps deeply-negative cell coords to wire (1,1)', () => {
      // clientX=-500 / CELL_W=10 = -50. Still clamps to 1 on the wire.
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: -500,
        clientY: -400,
        button: 0,
      });
      expect(harness.bytesOut).toHaveLength(1);
      expect(asText(harness.bytesOut)).toBe('\u001b[<0;1;1M');
    });

    it('large coordinates pass through (SGR 1006 has no 128-byte limit)', () => {
      // clientX=5000 / 10 = 500 → wire col = 501.
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 5000,
        clientY: 4000,
        button: 0,
      });
      expect(asText(harness.bytesOut)).toBe('\u001b[<0;501;201M');
    });
  });

  // ------------------------------------------------------------- mid-race
  describe('mode-change race', () => {
    it('ModeSnapshot is read per-event, so a flip between events is observed on the next event', () => {
      // input-host calls `encoder.encode()` per DOM event; the encoder
      // reads `ModeSnapshot` at the start of each encode. That means a
      // flip between two events shows up on the second event. (Within
      // a single encode, the snapshot is frozen — nothing to race against
      // since JS is single-threaded.)
      harness = makeHarness({
        mouseTracking: 'off',
        mouseEncoding: 'sgr',
      });
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 10,
        clientY: 20,
        button: 0,
      });
      expect(harness.bytesOut).toHaveLength(0); // off → suppressed

      harness.mirror.applyMode({ mouseTracking: 'button_event' });
      dispatchPointer(harness.container, 'pointerdown', {
        clientX: 10,
        clientY: 20,
        button: 0,
      });
      expect(harness.bytesOut).toHaveLength(1);
      expect(asText(harness.bytesOut)).toBe('\u001b[<0;2;2M');
    });
  });

  // ---------------------------------------------------------- wheel off
  describe('wheel with tracking off', () => {
    beforeEach(() => {
      harness = makeHarness(); // default off
    });

    it('wheel-up with tracking=off emits no bytes (browser scroll takes over)', () => {
      // xterm contract: wheel is a mouse-tracking-only event. When
      // tracking is off we emit zero bytes and input-host does not
      // preventDefault, so the DOM WheelEvent propagates to the
      // browser's native scroll handler.
      const wheelEv = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 0,
        clientY: 0,
        deltaY: -10,
      });
      harness.container.dispatchEvent(wheelEv);
      expect(harness.bytesOut).toHaveLength(0);
      // Not consumed — browser is free to scroll natively.
      expect(wheelEv.defaultPrevented).toBe(false);
    });

    it('wheel-down with tracking=off emits no bytes and does not preventDefault', () => {
      const wheelEv = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 0,
        clientY: 0,
        deltaY: 10,
      });
      harness.container.dispatchEvent(wheelEv);
      expect(harness.bytesOut).toHaveLength(0);
      expect(wheelEv.defaultPrevented).toBe(false);
    });
  });
});
