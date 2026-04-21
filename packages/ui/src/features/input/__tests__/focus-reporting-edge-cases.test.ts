/**
 * Plan 0005 P0 audit — Focus reporting (DECSET 1004) edge cases.
 *
 * Existing `Focus.test.ts` covers the happy-path emission. This file
 * pins the host wiring behaviors that matter for real sessions:
 *
 *   §4.1  blur after focus emits the correct byte order when focus
 *         reporting flips on mid-session.
 *   §4.2  focusReporting=false → no bytes even when focus/blur happen
 *         rapidly (pinned anti-flood).
 *   §4.3  input-host connects blur → `focus.encode({focused:false})`
 *         and focus → `focus.encode({focused:true})` in the correct
 *         order, not swapped.
 *   §4.4  Mode-change mid-session: turning focusReporting ON after the
 *         surface mounts produces bytes on the NEXT blur, not retroactively.
 */
import { describe, expect, it } from 'vitest';

import { Focus } from '../Focus';
import { KeyEncoder } from '../KeyEncoder';
import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import { MouseEncoder } from '../MouseEncoder';
import { Paste } from '../Paste';
import { mount } from '../input-host';
import type { FocusEvent, TerminalModeSnapshot } from '../types';

function snap(
  fr: boolean,
  overrides: Partial<Omit<TerminalModeSnapshot, 'snapshotEpoch'>> = {},
): TerminalModeSnapshot {
  return Object.freeze({
    decckm: false,
    bracketedPaste: false,
    focusReporting: fr,
    mouseTracking: 'off' as const,
    mouseEncoding: 'default' as const,
    modifyOtherKeys: 0 as const,
    kittyKeyboard: 0 as const,
    altScreen: false,
    synchronizedUpdate: false,
    snapshotEpoch: 0n,
    ...overrides,
  });
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function setupHost() {
  const mirror = createStubMirror();
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
  });

  return { container, handle, bytesOut, mirror };
}

// ---------------------------------------------------------------------------
// §4.1 — flipping focusReporting on mid-session enables subsequent blurs
// ---------------------------------------------------------------------------
describe('audit §4.1 — focus reporting toggled mid-session', () => {
  it('no bytes while reporting is off; byte on first blur AFTER mirror flip', () => {
    /**
     * Real vim sessions enable DECSET 1004 on entry. The surface is
     * already focused. The FIRST blur after the DECSET must emit
     * `ESC [ O`; no bytes should have leaked while reporting was off.
     */
    const { container, handle, bytesOut, mirror } = setupHost();

    // Focus first (tabindex=0 + body append makes it focusable).
    container.focus();
    expect(bytesOut.length).toBe(0);

    // Now the app enables focus reporting.
    mirror.applyMode({ focusReporting: true });

    // A blur -> focus cycle should emit ESC[O then ESC[I.
    container.dispatchEvent(new FocusEvent('blur'));
    container.dispatchEvent(new FocusEvent('focus'));
    const hex = bytesOut.map(toHex).join(' ');
    expect(hex).toBe('1b5b4f 1b5b49');
    handle.unmount();
  });
});

// ---------------------------------------------------------------------------
// §4.2 — reporting=off drops all focus transitions silently
// ---------------------------------------------------------------------------
describe('audit §4.2 — reporting disabled is a silent drop even under churn', () => {
  it('50 rapid focus-cycle events with reporting off produce 0 bytes', () => {
    /**
     * Without focus reporting, a jittery UI (opening/closing overlays
     * in quick succession) MUST NOT spam DSR bytes. Pinning this makes
     * sure a future refactor doesn't accidentally emit the bytes first
     * then drop them inside the encoder.
     */
    const { container, handle, bytesOut } = setupHost();
    for (let i = 0; i < 50; i += 1) {
      container.dispatchEvent(new FocusEvent('blur'));
      container.dispatchEvent(new FocusEvent('focus'));
    }
    expect(bytesOut.length).toBe(0);
    handle.unmount();
  });
});

// ---------------------------------------------------------------------------
// §4.3 — Focus encoder distinguishes in vs out unambiguously
// ---------------------------------------------------------------------------
describe('audit §4.3 — `ESC [ I` vs `ESC [ O` ordering is load-bearing', () => {
  it('focused:true → ESC [ I, focused:false → ESC [ O (not swapped)', () => {
    /**
     * The xterm spec is explicit: `ESC [ I` on focus-in, `ESC [ O` on
     * focus-out. vim's `set focus-events` notation mutates on the
     * expected variant. This is a regression guard against a future
     * refactor that accidentally swaps the two constants.
     */
    const focus = new Focus({
      modeSnapshot: new ModeSnapshot(createStubMirror()),
    });
    const focusEv: FocusEvent = { focused: true };
    const blurEv: FocusEvent = { focused: false };
    expect(toHex(focus.encode(focusEv, snap(true)).bytes)).toBe('1b5b49');
    expect(toHex(focus.encode(blurEv, snap(true)).bytes)).toBe('1b5b4f');
  });
});

// ---------------------------------------------------------------------------
// §4.4 — blur-before-focus ordering when paste dialog mounts
// ---------------------------------------------------------------------------
describe('audit §4.4 — focus bytes around an overlay open/close', () => {
  it('blur → (pretend overlay opens & closes) → focus emits exactly ESC[O then ESC[I', () => {
    /**
     * Simulates a paste-safety dialog opening (surface blurs), then
     * closing (surface re-focuses). The ordering must be preserved so
     * vim sees the brief blur and re-focus cleanly.
     */
    const { container, handle, bytesOut, mirror } = setupHost();
    mirror.applyMode({ focusReporting: true });

    container.dispatchEvent(new FocusEvent('blur'));
    container.dispatchEvent(new FocusEvent('focus'));

    expect(bytesOut.length).toBe(2);
    expect(toHex(bytesOut[0]!)).toBe('1b5b4f');
    expect(toHex(bytesOut[1]!)).toBe('1b5b49');
    handle.unmount();
  });
});
