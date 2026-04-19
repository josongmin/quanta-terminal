/**
 * **Final E2E — IME end-to-end flow**
 *
 * DOM composition events → `input-host` → `ImeStateMachine` → PreeditOverlay
 * + commit bytes. Every layer is real. Stubbed: `KeyEncoder` / `Paste` read
 * mode via the `createStubMirror` helper (real class, stubbed mirror).
 *
 * Retires RFC §22 #1 (Korean 2-set double-input) and ADR 0018 behaviour
 * (commit-only PTY emission, Esc cancel, blur policy) at the full-stack
 * UI observation point.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Focus } from '../../features/input/Focus.js';
import { KeyEncoder } from '../../features/input/KeyEncoder.js';
import { MouseEncoder } from '../../features/input/MouseEncoder.js';
import { Paste } from '../../features/input/Paste.js';
import { createStubMirror, ModeSnapshot } from '../../features/input/ModeSnapshot.js';
import type { PreeditOverlayProps } from '../../features/input/ime/ime-types.js';
import { mount } from '../../features/input/input-host.js';

interface Harness {
  container: HTMLElement;
  handle: ReturnType<typeof mount>;
  bytesOut: Uint8Array[];
  overlays: Array<PreeditOverlayProps | null>;
  banners: string[];
  disconnectHandlers: Array<() => void>;
  triggerSidecarDisconnect: () => void;
}

function makeHarness(platform: 'macos' | 'linux' | 'windows' = 'macos'): Harness {
  const mirror = createStubMirror();
  const modeSnapshot = new ModeSnapshot(mirror);
  const keyEncoder = new KeyEncoder({ modeSnapshot });
  const mouseEncoder = new MouseEncoder({ modeSnapshot });
  const paste = new Paste({ modeSnapshot });
  const focus = new Focus({ modeSnapshot });

  const bytesOut: Uint8Array[] = [];
  const overlays: Array<PreeditOverlayProps | null> = [];
  const banners: string[] = [];
  const disconnectHandlers: Array<() => void> = [];

  const container = document.createElement('div');
  container.setAttribute('tabindex', '0');
  document.body.appendChild(container);

  const handle = mount(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform,
    onBytesOut: (b) => bytesOut.push(b),
    onOverlayUpdate: (o) => overlays.push(o),
    onBanner: (m) => banners.push(m),
    onSidecarDisconnectSubscribe: (h) => {
      disconnectHandlers.push(h);
      return () => {
        const idx = disconnectHandlers.indexOf(h);
        if (idx >= 0) disconnectHandlers.splice(idx, 1);
      };
    },
  });

  return {
    container,
    handle,
    bytesOut,
    overlays,
    banners,
    disconnectHandlers,
    triggerSidecarDisconnect: () => {
      for (const h of disconnectHandlers) h();
    },
  };
}

/** Concatenate the accumulated byte buffer and return a hex string. */
function hexDump(bytesOut: readonly Uint8Array[]): string {
  const total = bytesOut.reduce((n, b) => n + b.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const b of bytesOut) {
    joined.set(b, o);
    o += b.length;
  }
  return Array.from(joined)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

describe('IME end-to-end (e2e)', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness('macos');
  });
  afterEach(() => {
    harness.handle.unmount();
    harness.container.remove();
  });

  it('composition commits once with the final grapheme bytes (Korean 한)', () => {
    const { container, bytesOut, overlays } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎㅏ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    // Final overlay update: unmounted (null).
    expect(overlays.at(-1)).toBeNull();
    // Commit bytes === UTF-8 for 한 (no bracketed paste on stub mirror).
    expect(hexDump(bytesOut)).toBe('ed959c');
  });

  it('keydown during Composing emits no PTY bytes (I-7: preedit never leaks)', () => {
    const { container, bytesOut } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    expect(bytesOut.length).toBe(before);
  });

  it('Esc during composition cancels without emitting the Esc byte (ADR 0018 T5)', () => {
    const { container, bytesOut, handle } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
    expect(bytesOut.length).toBe(before);
    expect(handle.state().kind).toBe('Idle');
  });

  it('empty compositionend is treated as cancel, no PTY bytes emitted (T4)', () => {
    const { container, bytesOut } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
    expect(bytesOut.length).toBe(before);
  });

  it('overlay mounts with the latest preedit text on compositionupdate', () => {
    const { container, overlays } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎㅏ' }));
    // The last non-null overlay carries the latest text.
    const lastWithText = [...overlays].reverse().find((o) => o !== null);
    expect(lastWithText?.text).toBe('ㅎㅏ');
  });

  it('macOS blur mid-composition cancels without emitting bytes (T7)', () => {
    const { container, bytesOut, handle } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    container.dispatchEvent(new Event('blur', { bubbles: false }));
    // Focus reporting stub is off, so no focus-byte on blur either.
    expect(bytesOut.length).toBe(before);
    expect(handle.state().kind).toBe('Idle');
  });

  it('Linux blur mid-composition preserves the Composing state (T8 persist window)', () => {
    // Swap to a Linux harness.
    harness.handle.unmount();
    harness.container.remove();
    harness = makeHarness('linux');
    const { container, handle } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new Event('blur', { bubbles: false }));
    // Still Composing — the 1s persist timer is live.
    expect(handle.state().kind).toBe('Composing');
  });

  it('sidecar-disconnect mid-composition shows the banner and clears overlay (T12/T13)', () => {
    const { container, banners, overlays, handle, triggerSidecarDisconnect } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    triggerSidecarDisconnect();
    expect(handle.state().kind).toBe('Idle');
    // Last overlay is null (unmounted).
    expect(overlays.at(-1)).toBeNull();
    // Banner fired with the expected recovery message.
    expect(banners.length).toBeGreaterThan(0);
    expect(banners.at(-1)).toMatch(/session restarted/u);
  });
});
