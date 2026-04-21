/**
 * E2E — interactive CLI app coverage (aws cli, tab-completion, job control)
 *
 * Covers input-encoding scenarios unique to interactive CLI apps that are NOT
 * exercised by `readline-shortcuts.e2e.test.tsx` (Ctrl+A/E/U/K/W) or
 * `tui-full-flow.e2e.test.tsx` (alt-screen toggle):
 *
 *   1. Tab  (0x09) — shell completion trigger; must not be wrapped in
 *      bracketed-paste sequences even when bracketedPaste mode is on.
 *   2. Ctrl+D (0x04) — EOF / "end of input"; used by `aws configure`
 *      to accept default values and by shells as logout.
 *   3. Ctrl+Z (0x1a) — SIGTSTP / background-job; common during long
 *      `aws` operations the user wants to background.
 *   4. Page Up / Page Down — ESC[5~ / ESC[6~; used by interactive pagers
 *      (`aws logs tail --follow`) that embed a less-style scroller.
 *   5. Shift+Tab (ESC[Z) — reverse-completion; used in some interactive
 *      aws-cli SSO pickers.
 *   6. Alt+. (ESC 0x2e) — "last arg" readline shortcut used frequently
 *      in aws workflows.
 *   7. Tab is NOT bracket-wrapped even with bracketedPaste=true — pinning
 *      the invariant that bracketedPaste only wraps clipboard paste events,
 *      not keyboard Tab.
 *
 * All tests use the encoder-level input-host harness (KeyEncoder +
 * ModeSnapshot + createStubMirror) because the interesting behavior is at
 * the byte-encoding layer, not the page rendering layer.
 *
 * Production gap documented: aws configure multi-round interactive prompt
 * (type answer → Enter → receive next prompt) exercises the normal block
 * flow, which is already covered by `composer-submit.e2e.test.tsx` and
 * `command-correction-flow.e2e.test.tsx`. No duplication.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Focus } from '../../features/input/Focus.js';
import { KeyEncoder } from '../../features/input/KeyEncoder.js';
import { MouseEncoder } from '../../features/input/MouseEncoder.js';
import { Paste } from '../../features/input/Paste.js';
import { createStubMirror, ModeSnapshot } from '../../features/input/ModeSnapshot.js';
import { mount } from '../../features/input/input-host.js';

// -------------------------------------------------------------------------
// Harness builder — same pattern as mouse-tracking.e2e.test.tsx.
// -------------------------------------------------------------------------

interface KeyHarness {
  container: HTMLElement;
  handle: ReturnType<typeof mount>;
  bytesOut: Uint8Array[];
  mirror: ReturnType<typeof createStubMirror>;
}

function makeHarness(
  init: Parameters<typeof createStubMirror>[0] = {},
): KeyHarness {
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

  const handle = mount(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform: 'linux',
    onBytesOut: (b) => bytesOut.push(b),
  });

  return { container, handle, bytesOut, mirror };
}

/** Flatten recorded Uint8Array chunks to a single array for assertion. */
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

function decode(buffers: readonly Uint8Array[]): string {
  return new TextDecoder().decode(flatten(buffers));
}

const harnesses: KeyHarness[] = [];

beforeEach(() => {
  harnesses.length = 0;
});

afterEach(() => {
  for (const h of harnesses) {
    h.handle.unmount();
    h.container.remove();
  }
});

function make(init?: Parameters<typeof createStubMirror>[0]): KeyHarness {
  const h = makeHarness(init);
  harnesses.push(h);
  return h;
}

// -------------------------------------------------------------------------
// Tests.
// -------------------------------------------------------------------------

describe('interactive CLI input encoding (e2e)', () => {
  it('Tab key emits a single 0x09 byte in normal mode', () => {
    const { container, bytesOut } = make();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }),
    );
    expect(decode(bytesOut)).toBe('\x09');
  });

  it('Tab key emits 0x09 even when bracketedPaste is on — Tab is not paste', () => {
    const { container, bytesOut } = make({ bracketedPaste: true });
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }),
    );
    // Must be raw 0x09, NOT ESC [ 200~ 0x09 ESC [ 201~.
    const str = decode(bytesOut);
    expect(str).toBe('\x09');
    expect(str).not.toContain('\x1b[200~');
  });

  it('Ctrl+D emits a single 0x04 byte (EOF / aws configure default accept)', () => {
    const { container, bytesOut } = make();
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'd',
        code: 'KeyD',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    expect(decode(bytesOut)).toBe('\x04');
  });

  it('Ctrl+Z emits a single 0x1a byte (SIGTSTP / background job)', () => {
    const { container, bytesOut } = make();
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        code: 'KeyZ',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    expect(decode(bytesOut)).toBe('\x1a');
  });

  it('Page Up emits ESC[5~ (used by less-style pagers inside aws logs)', () => {
    const { container, bytesOut } = make();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'PageUp', code: 'PageUp', bubbles: true }),
    );
    expect(decode(bytesOut)).toBe('\x1b[5~');
  });

  it('Page Down emits ESC[6~', () => {
    const { container, bytesOut } = make();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'PageDown', code: 'PageDown', bubbles: true }),
    );
    expect(decode(bytesOut)).toBe('\x1b[6~');
  });

  it('Shift+Tab emits ESC[Z (reverse-completion, used in aws SSO pickers)', () => {
    const { container, bytesOut } = make();
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        code: 'Tab',
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(decode(bytesOut)).toBe('\x1b[Z');
  });

  it('Alt+. emits ESC 0x2e (readline "last argument" shortcut)', () => {
    const { container, bytesOut } = make();
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '.',
        code: 'Period',
        altKey: true,
        bubbles: true,
      }),
    );
    // Alt+<printable> → ESC <printable> in legacy encoding.
    expect(decode(bytesOut)).toBe('\x1b.');
  });

  it('Page Up in alt-screen (DECCKM on) still emits ESC[5~ (not application-mode variant)', () => {
    // DECCKM only affects arrow keys; Page Up / Page Down are always CSI 5~ / 6~.
    const { container, bytesOut } = make({ decckm: true });
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'PageUp', code: 'PageUp', bubbles: true }),
    );
    expect(decode(bytesOut)).toBe('\x1b[5~');
  });

  it('sequential Tab completions each emit a separate 0x09 — no byte merging', () => {
    const { container, bytesOut } = make();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }),
    );
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }),
    );
    // Two separate Uint8Arrays, each containing 0x09.
    expect(bytesOut.length).toBe(2);
    expect(bytesOut[0]).toEqual(new Uint8Array([0x09]));
    expect(bytesOut[1]).toEqual(new Uint8Array([0x09]));
  });
});
