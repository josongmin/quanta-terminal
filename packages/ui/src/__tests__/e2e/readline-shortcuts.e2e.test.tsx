/**
 * **E2E — Readline-style key bindings**
 *
 * Validates that the bash/zsh/fish editing shortcuts every shell user
 * presses hundreds of times a day emit the exact same PTY bytes GNU
 * readline expects on a real terminal. Each test exercises the full
 * DOM path:
 *
 *   KeyboardEvent → `input-host` → `KeyEncoder` (legacy) → `onBytesOut`
 *
 * Harness is identical in shape to `input-full-loop.e2e.test.tsx`; we
 * re-use the stub `ModeSnapshot` (DECCKM off, kitty off) so the legacy
 * encoder is the sole byte producer.
 *
 * Reference: bash(1) "READLINE" section and terminfo entries on a
 * stock xterm. If any single byte here drifts, readline stops treating
 * Quanta as an xterm-compatible client and line editing breaks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Focus } from '../../features/input/Focus.js';
import { KeyEncoder } from '../../features/input/KeyEncoder.js';
import { MouseEncoder } from '../../features/input/MouseEncoder.js';
import { Paste } from '../../features/input/Paste.js';
import { createStubMirror, ModeSnapshot } from '../../features/input/ModeSnapshot.js';
import { mount } from '../../features/input/input-host.js';

interface InputHarness {
  container: HTMLElement;
  handle: ReturnType<typeof mount>;
  bytesOut: Uint8Array[];
}

function makeInputHarness(): InputHarness {
  const mirror = createStubMirror({});
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
    platform: 'linux',
    onBytesOut: (b) => bytesOut.push(b),
  });

  return { container, handle, bytesOut };
}

/** Flatten recorded byte chunks into one Uint8Array for hex comparison. */
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

function hex(buffers: readonly Uint8Array[]): string {
  return Array.from(flatten(buffers))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

function keyDown(
  el: HTMLElement,
  init: KeyboardEventInit & { key: string; code?: string },
): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

describe('readline-style key bindings (e2e)', () => {
  let harness: InputHarness;

  beforeEach(() => {
    harness = makeInputHarness();
  });

  afterEach(() => {
    harness.handle.unmount();
    harness.container.remove();
  });

  // -- Control-letter bindings (C0 range) ------------------------------------

  it('Ctrl+A → 0x01 (beginning-of-line)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'a', code: 'KeyA', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x01]);
  });

  it('Ctrl+E → 0x05 (end-of-line)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x05]);
  });

  it('Ctrl+U → 0x15 (unix-line-discard, kill to BOL)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'u', code: 'KeyU', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x15]);
  });

  it('Ctrl+K → 0x0b (kill-line to EOL)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x0b]);
  });

  it('Ctrl+W → 0x17 (unix-word-rubout, delete word backward)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'w', code: 'KeyW', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x17]);
  });

  it('Ctrl+L → 0x0c (clear-screen)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'l', code: 'KeyL', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x0c]);
  });

  it('Ctrl+R → 0x12 (reverse-search-history)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'r', code: 'KeyR', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x12]);
  });

  it('Ctrl+D → 0x04 (EOF / delete-char)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'd', code: 'KeyD', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x04]);
  });

  it('Ctrl+H → 0x08 (backward-delete-char as BS — distinct from Backspace=0x7f)', () => {
    // Key rationale: bash's tty layer maps BS and DEL both to
    // `backward-delete-char`, but readline users often bind Ctrl+H
    // explicitly, and terminals must send 0x08 here so that distinction
    // survives. Encoder uses the Ctrl-letter matrix (H & 0x1f = 0x08).
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'h', code: 'KeyH', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x08]);
  });

  it('Ctrl+T → 0x14 (transpose-chars)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 't', code: 'KeyT', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x14]);
  });

  it('Ctrl+Y → 0x19 (yank)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'y', code: 'KeyY', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x19]);
  });

  it('Ctrl+_ → 0x1f (undo)', () => {
    // Ctrl+_ arrives via the `CTRL_SYMBOL` map in legacy.ts, not the
    // letter matrix. Shift may or may not be asserted by the browser
    // depending on layout; we exercise it here because US keyboards
    // require Shift for the underscore glyph.
    const { container, bytesOut } = harness;
    keyDown(container, { key: '_', code: 'Minus', ctrlKey: true, shiftKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x1f]);
  });

  // -- Alt / Meta bindings ---------------------------------------------------

  it('Alt+B → ESC b (backward-word)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'b', code: 'KeyB', altKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x62]);
  });

  it('Alt+F → ESC f (forward-word)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'f', code: 'KeyF', altKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x66]);
  });

  it('Alt+D → ESC d (kill-word forward)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'd', code: 'KeyD', altKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x64]);
  });

  it('Alt+Backspace → ESC 0x7f (backward-kill-word)', () => {
    // Legacy encoder: `Backspace` + altKey (ctrlKey=false) takes the
    // default 0x7F branch wrapped by `wrapAlt` → [ESC, 0x7f].
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Backspace', code: 'Backspace', altKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x7f]);
  });

  it('Alt+. → ESC . (yank-last-arg)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: '.', code: 'Period', altKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x2e]);
  });

  // -- Tab family ------------------------------------------------------------

  it('Tab → 0x09 (complete)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Tab', code: 'Tab' });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x09]);
  });

  it('Shift+Tab → ESC [ Z (CBT / back-tab)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Tab', code: 'Tab', shiftKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(hex(bytesOut)).toBe('1b5b5a');
  });

  // -- Multi-keystroke chord -------------------------------------------------

  it('Ctrl+X Ctrl+E → 0x18 then 0x05 (edit-and-execute-command, each keydown emits its own byte)', () => {
    // Readline's `edit-and-execute-command` is bound to the two-step
    // chord `C-x C-e`; bash does NOT wait for a single combined
    // keystroke. The encoder must emit the first byte synchronously on
    // the first keydown so readline's kseq matcher advances its state
    // before the second byte arrives. We verify the emit happens
    // between the two dispatches.
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'x', code: 'KeyX', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x18]);

    keyDown(container, { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(bytesOut).toHaveLength(2);
    expect(Array.from(bytesOut[1]!)).toEqual([0x05]);

    // Concatenated stream is exactly the two-byte readline chord.
    expect(hex(bytesOut)).toBe('1805');
  });

  // -- Edge cases ------------------------------------------------------------

  it('unmodified Backspace stays 0x7f and does NOT collide with Ctrl+H=0x08', () => {
    // Paranoia test: readline relies on the terminal keeping BS (0x08)
    // and DEL (0x7f) distinct, otherwise `stty erase` semantics break.
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Backspace', code: 'Backspace' });
    keyDown(container, { key: 'h', code: 'KeyH', ctrlKey: true });
    expect(bytesOut).toHaveLength(2);
    expect(Array.from(bytesOut[0]!)).toEqual([0x7f]);
    expect(Array.from(bytesOut[1]!)).toEqual([0x08]);
  });

  it('Ctrl+X alone (without the Ctrl+E follow-up) emits exactly 0x18 and nothing more', () => {
    // The encoder holds no state; a dangling Ctrl+X must not stash a
    // prefix byte for a later key. This pins the "pure function" shape
    // of the legacy path so a future multi-step matcher wouldn't break
    // bash's own kseq timeout behaviour.
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'x', code: 'KeyX', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x18]);
  });
});
