/**
 * Plan 0005 P0 audit follow-up — paste / IME / mouse / keyboard
 * interleaving beyond Agent R's §7.
 *
 * R covered:
 *   §7.1 keydown → paste → keydown ordering.
 *   §7.3 keyup during Composing is suppressed.
 *   §7.4 blur during Composing cancels preedit (mac).
 *   §7.6 multi-host isolation.
 *   §7.7 paste serialization (no-gate / sync-true / sync-false).
 *
 * This file adds:
 *   §imx.1 mouse-press / mouse-release while IME is composing —
 *          mouse bytes still flow, IME state is untouched.
 *   §imx.2 paste landing in the middle of a mouse-drag — paste lands
 *          atomically, drag continues on the next mouse event.
 *   §imx.3 compositionstart DOES NOT flush keystrokes buffered on the
 *          same tick (documents current ordering).
 *   §imx.4 unmount mid-IME-composition releases the overlay and
 *          cancels the persist timer — no zombie overlay.
 *   §imx.5 two simultaneous paste events with an IME commit between —
 *          byte order is P1 → IME-commit → P2 in onBytesOut.
 *   §imx.6 mouse wheel under alt-screen while Composing — synthesized
 *          arrow bytes still emit (mouse bytes are NOT gated on IME).
 */
import { describe, expect, it } from 'vitest';

import { Focus } from '../Focus';
import { KeyEncoder } from '../KeyEncoder';
import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import { MouseEncoder } from '../MouseEncoder';
import { Paste } from '../Paste';
import { mount } from '../input-host';
import type { InputHostHandle, PreeditOverlayProps } from '../index';

interface Rig {
  container: HTMLDivElement;
  handle: InputHostHandle;
  bytesOut: Uint8Array[];
  overlay: Array<PreeditOverlayProps | null>;
  mirror: ReturnType<typeof createStubMirror>;
}

function setup(
  overrides: Partial<Parameters<typeof mount>[1]> = {},
  mirrorInitial: Parameters<typeof createStubMirror>[0] = {},
): Rig {
  const mirror = createStubMirror(mirrorInitial);
  const modeSnapshot = new ModeSnapshot(mirror);
  const keyEncoder = new KeyEncoder({ modeSnapshot });
  const mouseEncoder = new MouseEncoder({ modeSnapshot });
  const paste = new Paste({ modeSnapshot });
  const focus = new Focus({ modeSnapshot });

  const bytesOut: Uint8Array[] = [];
  const overlay: Array<PreeditOverlayProps | null> = [];
  const container = document.createElement('div');
  container.setAttribute('tabindex', '0');
  document.body.appendChild(container);

  const handle = mount(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform: 'macos',
    onBytesOut: (b) => bytesOut.push(b),
    onOverlayUpdate: (o) => overlay.push(o),
    ...overrides,
  });
  return { container, handle, bytesOut, overlay, mirror };
}

function firePaste(container: HTMLElement, text: string): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text' ? text : '') },
  });
  container.dispatchEvent(ev);
}

function firePointer(
  container: HTMLElement,
  type: 'pointerdown' | 'pointerup' | 'pointermove',
  init: Partial<MouseEventInit> & { buttons?: number } = {},
): void {
  // jsdom lacks a native PointerEvent constructor, but the host only
  // reads MouseEvent-surfaced fields (button, buttons, clientX/Y,
  // modifiers). Dispatching a MouseEvent under the pointer type
  // satisfies the listener without forcing a jsdom polyfill.
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  // `buttons` is readonly on MouseEvent in jsdom; force via redefine.
  if (init.buttons !== undefined) {
    Object.defineProperty(ev, 'buttons', { value: init.buttons });
  }
  container.dispatchEvent(ev);
}

function fireWheel(
  container: HTMLElement,
  init: Partial<WheelEventInit> = {},
): void {
  const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  container.dispatchEvent(ev);
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

function cat(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return toHex(out);
}

describe('audit §imx.1 — mouse clicks during IME composition keep flowing', () => {
  it('mousedown + mouseup while Composing emit mouse bytes; composition is untouched', () => {
    // Per ADR 0018: the paste / input-host handlers are state-agnostic
    // with respect to the IME state. Mouse events are NOT gated on the
    // composition — selecting text with the mouse while composing
    // should work on any platform.
    const { container, handle, bytesOut } = setup(
      {
        screenToCell: () => ({ xCell: 4, yCell: 2 }),
      },
      { mouseTracking: 'button_event', mouseEncoding: 'sgr' },
    );

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));

    firePointer(container, 'pointerdown', { button: 0, clientX: 40, clientY: 20 });
    firePointer(container, 'pointerup', { button: 0, clientX: 40, clientY: 20 });

    // Mouse bytes land: press is cb=0 terminator M; release is cb=0 terminator m.
    const mouseBytes = bytesOut.filter((b) => b.length > 0);
    expect(mouseBytes.length).toBe(2);
    expect(toHex(mouseBytes[0]!)).toBe('1b5b3c303b353b334d'); // ESC [ < 0 ; 5 ; 3 M
    expect(toHex(mouseBytes[1]!)).toBe('1b5b3c303b353b336d'); // ESC [ < 0 ; 5 ; 3 m

    // Composition is still live — we can commit afterward.
    const prevLen = bytesOut.length;
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    // '한' UTF-8: e d 95 9c
    const committed = bytesOut.slice(prevLen);
    expect(committed.length).toBe(1);
    expect(toHex(committed[0]!)).toBe('ed959c');

    handle.unmount();
  });
});

describe('audit §imx.2 — paste atomically interleaves with a mouse-drag', () => {
  it('drag → paste → drag emits [drag][paste][drag] in one bytesOut stream', () => {
    const { container, handle, bytesOut } = setup(
      {
        screenToCell: (x) => ({ xCell: x, yCell: 0 }),
      },
      { mouseTracking: 'button_event', mouseEncoding: 'sgr', bracketedPaste: false },
    );

    // Press + first drag
    firePointer(container, 'pointerdown', { button: 0, clientX: 1, clientY: 0 });
    firePointer(container, 'pointermove', { button: 0, buttons: 1, clientX: 2, clientY: 0 });

    // Paste lands atomically — the encoder emits a SINGLE onBytesOut
    // for the whole text (no interleaving with the next mouse event).
    firePaste(container, 'X');

    // Next drag
    firePointer(container, 'pointermove', { button: 0, buttons: 1, clientX: 3, clientY: 0 });

    // Drag #1 = cb 32 (drag+left); Drag #2 = same; paste = 'X' = 0x58.
    // Positions are 1-based in SGR.
    const hexes = bytesOut.map((b) => toHex(b));
    expect(hexes).toEqual([
      '1b5b3c303b323b314d',  // press at (1,0) → 2;1
      '1b5b3c33323b333b314d', // drag at (2,0) → 3;1, cb=32
      '58',                   // paste 'X'
      '1b5b3c33323b343b314d', // drag at (3,0) → 4;1, cb=32
    ]);
    // Concatenated byte-stream is the expected interleaving.
    expect(cat(bytesOut)).toBe(hexes.join(''));

    handle.unmount();
  });
});

describe('audit §imx.3 — compositionstart does NOT retroactively suppress prior keystrokes', () => {
  it('keydown(a) → compositionstart → compositionend(b) emits ["a","b"] in order', () => {
    // If the user typed 'a' and THEN engaged IME (mid-sentence Hangul
    // mode toggle), the 'a' must have already reached the wire. The
    // encoder runs per-event synchronously; no retroactive gating.
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅂ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '밤' }));
    const hexes = bytesOut.map((b) => toHex(b));
    // 'a' plus the UTF-8 of '밤' (eb b0 a4).
    expect(hexes).toEqual(['61', 'ebb0a4']);
    handle.unmount();
  });
});

describe('audit §imx.4 — unmount during an active composition releases resources', () => {
  it('unmount mid-Composing drops further events with no zombie overlay', () => {
    // The user starts composing, then closes the session tab. The
    // host's unmount() path must:
    //   1. Stop receiving further composition events.
    //   2. Clear the persist timer (if started) — no late
    //      persist-timer-expired firing into a dead listener.
    const { container, handle, bytesOut, overlay } = setup();
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㄱ' }));
    // Overlay was emitted at least once.
    expect(overlay.length).toBeGreaterThan(0);
    const overlayCountBefore = overlay.length;

    handle.unmount();

    // Post-unmount events must not be consumed by the host.
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㄱㅏ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '가' }));
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }),
    );

    // No new bytes, no new overlay updates.
    expect(bytesOut.length).toBe(0);
    expect(overlay.length).toBe(overlayCountBefore);
  });
});

describe('audit §imx.5 — paste before and after an IME commit preserves order', () => {
  it('paste("A") → IME commit "한" → paste("B") emits [A, 한, B]', () => {
    const { container, handle, bytesOut } = setup();
    firePaste(container, 'A');
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    firePaste(container, 'B');

    const hexes = bytesOut.map((b) => toHex(b));
    expect(hexes).toEqual(['41', 'ed959c', '42']);
    handle.unmount();
  });
});

describe('audit §imx.6 — wheel-to-arrow under alt-screen is NOT gated on IME state', () => {
  it('wheel-up during Composing still synthesizes an ArrowUp byte', () => {
    // Per MouseEncoder §alt-screen: wheel translates to arrow-keys when
    // tracking is off AND altScreen=true. The IME state machine does
    // NOT gate mouse events (only keyboard is suppressed during
    // composition). Pagers must remain scrollable.
    const { container, handle, bytesOut, mirror } = setup(
      {
        screenToCell: () => ({ xCell: 0, yCell: 0 }),
      },
      { altScreen: true, mouseTracking: 'off' },
    );

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    fireWheel(container, { deltaY: -20, deltaMode: 0 });

    // deltaY -20 / 16 = 1 line up → ArrowUp CSI: ESC [ A = 1b 5b 41
    const nonEmpty = bytesOut.filter((b) => b.length > 0);
    expect(nonEmpty.length).toBe(1);
    expect(toHex(nonEmpty[0]!)).toBe('1b5b41');

    // Suppress unused warning
    void mirror;
    handle.unmount();
  });
});
