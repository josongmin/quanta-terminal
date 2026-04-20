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
  /** Advance the simulated clock and fire any due deferred timers. */
  advanceTime: (ms: number) => void;
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

  // Deterministic clock + timer queue so we can exercise the 1-second
  // persist-window without real wall-clock waits. The IME state machine
  // asks for `now()` on every transition and `setTimeoutFn` to start
  // the persist timer; we satisfy both from this in-memory queue.
  let clockMs = 0;
  interface Scheduled {
    fireAt: number;
    fn: () => void;
    cancelled: boolean;
  }
  const scheduled: Scheduled[] = [];
  const setTimeoutFn = (fn: () => void, ms: number): Scheduled => {
    const entry: Scheduled = { fireAt: clockMs + ms, fn, cancelled: false };
    scheduled.push(entry);
    return entry;
  };
  const clearTimeoutFn = (handle: unknown): void => {
    (handle as Scheduled).cancelled = true;
  };

  const handle = mount(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform,
    now: () => clockMs,
    setTimeoutFn,
    clearTimeoutFn,
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
    advanceTime: (ms: number) => {
      clockMs += ms;
      // Fire any non-cancelled timers whose fireAt is due. Stable order.
      for (const entry of [...scheduled]) {
        if (!entry.cancelled && entry.fireAt <= clockMs) {
          entry.cancelled = true;
          entry.fn();
        }
      }
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

  // ---- Audit pass 2026-04-20 additions ----------------------------------
  //
  // The prior suite missed transitions T6 (keydown-other), T9 (focus
  // re-anchor), T10 (persist-timer expiry), T15 (nested compositionstart),
  // and T16/T17 (resize re-anchor). It also did not verify that
  // Composing-state `text` updates step-by-step, nor that keyup is
  // suppressed during composition. Each of those is now pinned below.

  it('T2: Composing state `text` field advances with each compositionupdate', () => {
    const { container, handle } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(handle.state()).toMatchObject({ kind: 'Composing', text: '' });
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    expect(handle.state()).toMatchObject({ kind: 'Composing', text: 'ㅎ' });
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎㅏ' }));
    expect(handle.state()).toMatchObject({ kind: 'Composing', text: 'ㅎㅏ' });
  });

  it('T2: overlay text progression on each update is observable in order', () => {
    const { container, overlays } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎㅏ' }));
    // Filter to overlays with a text string and confirm the progression.
    const texts = overlays
      .filter((o): o is PreeditOverlayProps => o !== null)
      .map((o) => o.text);
    // First mount with '' then two updates to 'ㅎ', 'ㅎㅏ'. The first
    // mount overlay may share `text === ''` depending on event order;
    // what matters is that both intermediate texts appear in order.
    const ㅎIdx = texts.indexOf('ㅎ');
    const ㅎㅏIdx = texts.indexOf('ㅎㅏ');
    expect(ㅎIdx).toBeGreaterThanOrEqual(0);
    expect(ㅎㅏIdx).toBeGreaterThan(ㅎIdx);
  });

  it('T6: non-Esc keydown during Composing is suppressed AND state stays Composing', () => {
    const { container, bytesOut, handle } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    // A plain letter, then a Ctrl combo (which would normally encode to
    // 0x03), then an ArrowUp. All must be suppressed during composition
    // and the state must remain Composing.
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true }),
    );
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', bubbles: true }),
    );
    expect(bytesOut.length).toBe(before);
    expect(handle.state().kind).toBe('Composing');
  });

  it('keyup during Composing emits no bytes', () => {
    const { container, bytesOut } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    container.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    expect(bytesOut.length).toBe(before);
  });

  it('T15: nested compositionstart is treated as update, state remains Composing', () => {
    const { container, handle, overlays } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    // Nested start with different data.
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: 'X' }));
    // State still Composing, text adopted from nested start.
    expect(handle.state()).toMatchObject({ kind: 'Composing', text: 'X' });
    // Overlay was updated (not re-mounted) — no null overlays in the
    // tail because we never unmounted.
    expect(overlays.at(-1)).not.toBeNull();
  });

  it('T16: window resize while Composing re-anchors overlay without changing state', () => {
    const { container, handle, overlays } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const lenBefore = overlays.length;
    window.dispatchEvent(new Event('resize'));
    // re-anchor effect pushed exactly one new overlay (same text, same
    // dimmed state, potentially new anchor). State unchanged.
    expect(overlays.length).toBe(lenBefore + 1);
    expect(overlays.at(-1)).not.toBeNull();
    expect(overlays.at(-1)?.text).toBe('ㅎ');
    expect(handle.state().kind).toBe('Composing');
  });

  it('T9: Linux focus after blur un-dims overlay and keeps state Composing (persisted cleared)', () => {
    harness.handle.unmount();
    harness.container.remove();
    harness = makeHarness('linux');
    const { container, handle, overlays } = harness;

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new Event('blur', { bubbles: false }));
    // After blur, overlay is dimmed.
    expect(overlays.at(-1)?.dimmed).toBe(true);
    expect(handle.state()).toMatchObject({ kind: 'Composing', persisted: true });

    container.dispatchEvent(new Event('focus', { bubbles: false }));
    // Un-dim applied, persisted cleared.
    expect(overlays.at(-1)?.dimmed).toBeUndefined();
    expect(handle.state()).toMatchObject({ kind: 'Composing', persisted: false });
  });

  it('T10: Linux blur then 1s timeout cancels composition without emitting PTY bytes', () => {
    harness.handle.unmount();
    harness.container.remove();
    harness = makeHarness('linux');
    const { container, handle, overlays, bytesOut, advanceTime } = harness;

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    container.dispatchEvent(new Event('blur', { bubbles: false }));
    // Still Composing immediately.
    expect(handle.state().kind).toBe('Composing');

    // Advance beyond the 1s persist window — the timer fires, state goes Idle.
    advanceTime(1001);
    expect(handle.state().kind).toBe('Idle');
    expect(overlays.at(-1)).toBeNull();
    expect(bytesOut.length).toBe(before);
  });

  it('Korean 2-set full sequence ㅎ → 하 → 한 → commit emits exactly ed959c', () => {
    // Full RFC §22 #1 scenario: three update cycles followed by commit.
    // This exercises both the overlay text progression and the final
    // single byte-emission for the entire composition.
    const { container, overlays, bytesOut, handle } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: '하' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: '한' }));
    // Still Composing, bytes still empty.
    expect(handle.state().kind).toBe('Composing');
    expect(bytesOut.length).toBe(0);

    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    // Exactly one chunk, exactly UTF-8 of 한 (0xED 0x95 0x9C).
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0xed, 0x95, 0x9c]);
    expect(hexDump(bytesOut)).toBe('ed959c');
    expect(handle.state().kind).toBe('Idle');
    expect(overlays.at(-1)).toBeNull();
  });

  it('multi-grapheme Korean commit "안녕" → 6 bytes UTF-8, single emit', () => {
    // 안 = 0xEC 0x95 0x88, 녕 = 0xEB 0x85 0x95 → 6 bytes total.
    const { container, bytesOut } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: '안' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '안녕' }));
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0xec, 0x95, 0x88, 0xeb, 0x85, 0x95]);
  });

  it('Esc-cancel then new composition works independently (state machine resets cleanly)', () => {
    const { container, bytesOut, handle, overlays } = harness;
    // First cycle: cancel.
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
    expect(handle.state().kind).toBe('Idle');
    expect(overlays.at(-1)).toBeNull();

    // Second cycle: full commit. No state leaked from the first.
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅂ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '바' }));
    // Only the commit bytes from the second cycle.
    expect(bytesOut).toHaveLength(1);
    // 바 = 0xEB 0x94 0x94 ... let's compute: 바 = U+BC14 = 0xEB 0xB0 0x94.
    expect(Array.from(bytesOut[0]!)).toEqual([0xeb, 0xb0, 0x94]);
    expect(handle.state().kind).toBe('Idle');
  });

  it('sidecar-disconnect unsubscribe on unmount removes the handler', () => {
    const { handle, disconnectHandlers } = harness;
    expect(disconnectHandlers).toHaveLength(1);
    handle.unmount();
    expect(disconnectHandlers).toHaveLength(0);
    // Rebuild so afterEach's cleanup is still valid.
    harness = makeHarness('macos');
  });
});
