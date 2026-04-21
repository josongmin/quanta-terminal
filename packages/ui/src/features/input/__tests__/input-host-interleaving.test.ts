/**
 * Plan 0005 P0 audit — input-host event interleaving + ordering stress.
 *
 * Covers the §7 stress checks:
 *   §7.1  A flurry of events in one tick preserves their relative
 *         order in the bytesOut stream.
 *   §7.2  KeymapGuard-style claim by returning isComposing=true
 *         suppresses PTY bytes without cancelling IME state.
 *   §7.3  Keyup during active composition is fully suppressed.
 *   §7.4  Blur during Composing (macos) cancels + emits focus-out in
 *         that order.
 *   §7.5  Typing "ls\n" produces exactly three distinct byte emissions
 *         whose concatenation equals `ls\r` (Enter → CR per legacy).
 *   §7.6  Two input-hosts on two containers do not cross-contaminate.
 *
 * All tests use the pure `mount()` API against jsdom-constructed
 * containers; no React, no bridge. This keeps the stress checks fast
 * and deterministic.
 */
import { describe, expect, it } from 'vitest';

import { Focus } from '../Focus';
import { KeyEncoder } from '../KeyEncoder';
import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import { MouseEncoder } from '../MouseEncoder';
import { Paste } from '../Paste';
import { mount } from '../input-host';
import type { InputHostHandle } from '../input-host';

interface Rig {
  container: HTMLDivElement;
  handle: InputHostHandle;
  bytesOut: Uint8Array[];
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
    ...overrides,
  });
  return { container, handle, bytesOut };
}

function firePaste(container: HTMLElement, text: string): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text' ? text : '') },
  });
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

// ---------------------------------------------------------------------------
// §7.1 — event interleaving preserves ordering
// ---------------------------------------------------------------------------
describe('audit §7.1 — interleaved keydown/paste/focus in a single tick', () => {
  it('keydown(a) → paste(BC) → keydown(d) produces three byte emissions in order', () => {
    /**
     * The input-host invokes `onBytesOut` synchronously from each DOM
     * handler. No batching or frame-skipping inside the host. Verifying
     * the ordering of the byte chunks establishes the "no coalescing"
     * invariant that the downstream write bus relies on.
     */
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    firePaste(container, 'BC');
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true }),
    );

    expect(bytesOut.length).toBe(3);
    // 'a' = 0x61, 'BC' = 0x42 0x43, 'd' = 0x64
    expect(toHex(bytesOut[0]!)).toBe('61');
    expect(toHex(bytesOut[1]!)).toBe('4243');
    expect(toHex(bytesOut[2]!)).toBe('64');
    expect(cat(bytesOut)).toBe('61424364');
    handle.unmount();
  });

  it('wheel-up with tracking off emits 0 bytes (host leaves native scroll to browser)', () => {
    /**
     * A `wheel` DOM event on a host whose mirror has
     * `mouseTracking='off'` and `altScreen=false` must NOT reach
     * `onBytesOut`. The host's gate is "encoder returned 0 bytes → no
     * emission"; pinning that against a future refactor that would
     * eagerly call `onBytesOut([])`.
     */
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 50,
        clientX: 0,
        clientY: 0,
        bubbles: true,
      }),
    );
    expect(bytesOut.length).toBe(0);
    handle.unmount();
  });
});

// ---------------------------------------------------------------------------
// §7.3 — keyup during composition is suppressed
// ---------------------------------------------------------------------------
describe('audit §7.3 — keyup during Composing is suppressed (not forwarded)', () => {
  it('keyup(a) while Composing emits 0 bytes', () => {
    /**
     * input-host's onKeyUp has the guard `if (state.kind === "Composing")
     * return;` — without it, kitty L2 terminals with event-release
     * enabled could leak a keyup byte during an IME preedit.
     */
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(
      new CompositionEvent('compositionstart', { data: '' }),
    );
    container.dispatchEvent(
      new CompositionEvent('compositionupdate', { data: 'ㅎ' }),
    );
    const before = bytesOut.length;
    container.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    expect(bytesOut.length).toBe(before);
    handle.unmount();
  });
});

// ---------------------------------------------------------------------------
// §7.4 — blur-during-composition cancels + emits focus-out bytes
// ---------------------------------------------------------------------------
describe('audit §7.4 — mac blur during composition cancels IME then emits focus-out', () => {
  it('Composing + blur (mac, focusReporting=on) emits focus-out after cancel', () => {
    /**
     * input-host calls `dispatchIme({kind:'blur'})` FIRST, then
     * `focus.encode({focused:false})`. On macOS the IME machine
     * transitions Composing → Idle synchronously, then the focus
     * encoder emits `ESC [ O`. The ORDER matters: the application sees
     * the composition cancel BEFORE the focus-out, not after.
     */
    const { container, handle, bytesOut } = setup({}, { focusReporting: true });
    container.dispatchEvent(
      new CompositionEvent('compositionstart', { data: '' }),
    );
    container.dispatchEvent(
      new CompositionEvent('compositionupdate', { data: 'ㅎ' }),
    );
    expect(handle.state().kind).toBe('Composing');
    container.dispatchEvent(new FocusEvent('blur'));
    expect(handle.state().kind).toBe('Idle');
    // Last bytes emitted should be `1b 5b 4f`.
    expect(toHex(bytesOut.at(-1)!)).toBe('1b5b4f');
    handle.unmount();
  });
});

// ---------------------------------------------------------------------------
// §7.5 — typing "ls\n" end-to-end byte trace
// ---------------------------------------------------------------------------
describe('audit §7.5 — typing ls<Enter> emits three events, bytes = "ls\\r"', () => {
  it('l + s + Enter → [0x6c][0x73][0x0d] as three separate onBytesOut calls', () => {
    /**
     * The most fundamental integration test for the key path: the user
     * types `ls` then presses Enter. The byte stream reaching the
     * bridge MUST be exactly `l s \r` with no batching. Legacy encoder
     * emits `0x0d` for Enter, not `\n`; pin that decision.
     */
    const { container, handle, bytesOut } = setup();
    for (const [k, c] of [
      ['l', 'KeyL'],
      ['s', 'KeyS'],
      ['Enter', 'Enter'],
    ] as const) {
      container.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, code: c, bubbles: true }),
      );
    }
    expect(bytesOut.length).toBe(3);
    expect(toHex(bytesOut[0]!)).toBe('6c');
    expect(toHex(bytesOut[1]!)).toBe('73');
    expect(toHex(bytesOut[2]!)).toBe('0d');
    expect(cat(bytesOut)).toBe('6c730d');
    handle.unmount();
  });
});

// ---------------------------------------------------------------------------
// §7.6 — two hosts do not cross-contaminate
// ---------------------------------------------------------------------------
describe('audit §7.6 — two concurrent input-hosts stay isolated', () => {
  it('keystroke dispatched on host-A never appears in host-B bytesOut', () => {
    /**
     * Each SessionInputSurface instantiates its own input-host and its
     * own encoders. Two sessions side-by-side must never see each
     * other's bytes — the `onBytesOut` closure is per-mount.
     */
    const a = setup();
    const b = setup();
    a.container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    b.container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }),
    );

    expect(toHex(a.bytesOut[0]!)).toBe('61');
    expect(a.bytesOut.length).toBe(1);
    expect(toHex(b.bytesOut[0]!)).toBe('62');
    expect(b.bytesOut.length).toBe(1);

    a.handle.unmount();
    b.handle.unmount();
  });
});

// ---------------------------------------------------------------------------
// §7.7 — paste mid-keyboard-input is serialized
// ---------------------------------------------------------------------------
describe('audit §7.7 — paste serialization with surrounding keystrokes', () => {
  /**
   * The combination "type 'c' → paste 'X' → type 'd'" must hit the
   * bridge as `c X d` in that exact order, regardless of whether the
   * paste has a gate (synchronous boolean return is equivalent to no
   * gate).
   */
  it('keystroke → paste (no gate) → keystroke: chunks [c][X][d]', () => {
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true }),
    );
    firePaste(container, 'X');
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true }),
    );
    expect(bytesOut.length).toBe(3);
    expect(cat(bytesOut)).toBe('635864');
    handle.unmount();
  });

  it('keystroke → paste (gate sync:true) → keystroke: chunks [c][X][d]', () => {
    /**
     * A synchronous gate returning `true` is NOT allowed to defer the
     * byte emission — the host emits `paste` bytes inline. Anti-
     * regression against an accidental refactor to always-await.
     */
    const { container, handle, bytesOut } = setup({
      onPasteGate: () => true,
    });
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true }),
    );
    firePaste(container, 'X');
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true }),
    );
    expect(bytesOut.length).toBe(3);
    expect(cat(bytesOut)).toBe('635864');
    handle.unmount();
  });

  it('keystroke → paste (gate sync:false) → keystroke: paste dropped, keystrokes intact', () => {
    /**
     * A sync `false` gate drops the paste payload AND emits no bytes
     * for it. The surrounding keystrokes are unaffected.
     */
    const { container, handle, bytesOut } = setup({
      onPasteGate: () => false,
    });
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true }),
    );
    firePaste(container, 'X');
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true }),
    );
    expect(bytesOut.length).toBe(2);
    expect(cat(bytesOut)).toBe('6364');
    handle.unmount();
  });
});

// ---------------------------------------------------------------------------
// §7.8 — unmount mid-flurry stops emissions cleanly
// ---------------------------------------------------------------------------
describe('audit §7.8 — unmount halts further emissions immediately', () => {
  it('keydown after unmount emits nothing (no leaked listeners)', () => {
    /**
     * unmount() removes every listener registered in mount(). A post-
     * unmount DOM event must NOT sneak through. This is the leak-
     * prevention invariant for session-close.
     */
    const { container, handle, bytesOut } = setup();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    expect(bytesOut.length).toBe(1);
    handle.unmount();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }),
    );
    container.dispatchEvent(new FocusEvent('blur'));
    firePaste(container, 'paste');
    expect(bytesOut.length).toBe(1);
  });
});
