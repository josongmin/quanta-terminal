/**
 * **E2E — IME composition x bracketed-paste interactions**
 *
 * Covers the two features where their wire-layer encodings intersect:
 *
 *  1. IME commit (ADR 0018 T3 + I-4) uses the shared `Paste.encode()` path,
 *     so when DECSET 2004 (bracketed paste) is on the commit bytes MUST be
 *     wrapped with `ESC [ 200 ~` / `ESC [ 201 ~` sentinels — the same encoder
 *     that wraps real paste events. This guards against RFC §22 #13
 *     (bracketed paste leaks) being re-introduced on the IME path.
 *  2. Paste events arriving during an active composition — order guarantees,
 *     snapshot-at-encode-time semantics, and embedded-sentinel stripping.
 *
 * Every layer is real: DOM → `input-host` → `ImeStateMachine` → `Paste`. The
 * stub surface is `createStubMirror` only (for DECSET 2004 toggling).
 *
 * Notes on expectations:
 *   - Per ADR 0018 §2 I-4 the commit wraps with sentinels when bracketed
 *     paste is on. This test pins that behavior explicitly.
 *   - Per EPIC-E §5 Paste.encode() strips embedded sentinels from the
 *     payload before wrapping — implemented in Paste.ts via
 *     `stripEmbeddedSentinels`.
 *   - The mode snapshot is re-read at `encode()` time (ModeSnapshot.read()
 *     per call). The "snapshot freeze during paste" intent from ADR 0018 is
 *     therefore enforced at a point-in-time-of-encode granularity: once the
 *     `Paste.encode()` call is in flight, the returned bytes reflect the
 *     mode as-of that call. Paste is single-shot and synchronous, so there
 *     is no "mid-paste" mutation window at this layer.
 */

import { afterEach, describe, expect, it } from 'vitest';

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
  mirror: ReturnType<typeof createStubMirror>;
}

function makeHarness(
  init: Parameters<typeof createStubMirror>[0] = {},
  platform: 'macos' | 'linux' | 'windows' = 'macos',
): Harness {
  const mirror = createStubMirror(init);
  const modeSnapshot = new ModeSnapshot(mirror);
  const keyEncoder = new KeyEncoder({ modeSnapshot });
  const mouseEncoder = new MouseEncoder({ modeSnapshot });
  const paste = new Paste({ modeSnapshot });
  const focus = new Focus({ modeSnapshot });

  const bytesOut: Uint8Array[] = [];
  const overlays: Array<PreeditOverlayProps | null> = [];

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
  });

  return { container, handle, bytesOut, overlays, mirror };
}

/** Concatenate recorded byte chunks for easy assertions. */
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

/**
 * jsdom's `Event` has no `clipboardData`; attach a minimal shim covering the
 * single method `input-host` reads (`getData('text')`). Matches the helper
 * in `input-full-loop.e2e.test.tsx`.
 */
function dispatchPaste(el: HTMLElement, text: string): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text' ? text : '') },
  });
  el.dispatchEvent(ev);
}

// Byte sequences referenced by multiple assertions.
const START_HEX = '1b5b3230307e'; // ESC [ 2 0 0 ~
const END_HEX = '1b5b3230317e'; // ESC [ 2 0 1 ~
const HAN_HEX = 'ed959c'; // UTF-8 of 한

describe('IME x bracketed-paste interactions (e2e)', () => {
  let harness: Harness;

  afterEach(() => {
    harness?.handle.unmount();
    harness?.container.remove();
  });

  // ------------------------------------------------------------------
  // 1. Plain commit — bracketed paste OFF (control: no wrapping).
  // ------------------------------------------------------------------
  it('Korean commit with bracketed paste OFF → 3 bytes, no sentinel wrapping', () => {
    harness = makeHarness({ bracketedPaste: false });
    const { container, bytesOut } = harness;

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));

    // 한 is 3 bytes (UTF-8) — no sentinel wrapping.
    expect(hex(bytesOut)).toBe(HAN_HEX);
  });

  // ------------------------------------------------------------------
  // 2. Plain commit — bracketed paste ON. ADR 0018 §2 I-4 and EPIC-E
  //    §5.3 T3 both specify that commit flows through `Paste.encode()`,
  //    so DECSET 2004 DOES wrap the commit. Pin this.
  // ------------------------------------------------------------------
  it('Korean commit with bracketed paste ON → wrapped with ESC[200~ … ESC[201~ (ADR 0018 I-4)', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut } = harness;

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));

    // Commit goes through `Paste.encode()` per the state machine's
    // `emit-commit-bytes` side effect; the shared encoder sees bracketed
    // paste ON and wraps the commit bytes. This matches I-4 exactly and
    // is what protects against the "vim insert sees bracketed sentinel"
    // leak described in RFC §22 #13 also for the IME path.
    expect(hex(bytesOut)).toBe(`${START_HEX}${HAN_HEX}${END_HEX}`);
  });

  // ------------------------------------------------------------------
  // 3. Paste event during Composing — observation of order.
  //    Paste handler in input-host does NOT gate on state.kind, so the
  //    paste bytes are emitted synchronously inline with the paste
  //    dispatch. The IME overlay keeps state; the subsequent commit
  //    flushes after.
  // ------------------------------------------------------------------
  it('paste while Composing emits paste bytes immediately, IME commit flushes later (order preserved)', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut, handle } = harness;

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    expect(handle.state().kind).toBe('Composing');

    // Paste arrives mid-composition. input-host's paste handler is
    // state-agnostic — it encodes and emits right away.
    dispatchPaste(container, 'X');
    expect(bytesOut.length).toBe(1);
    expect(hex([bytesOut[0]!])).toBe(`${START_HEX}58${END_HEX}`); // 'X' = 0x58

    // Commit fires after — distinct byte chunk appended at the end.
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    expect(bytesOut.length).toBe(2);
    expect(hex([bytesOut[1]!])).toBe(`${START_HEX}${HAN_HEX}${END_HEX}`);

    // Full wire order: paste-wrapped-X, then commit-wrapped-한.
    expect(hex(bytesOut)).toBe(
      `${START_HEX}58${END_HEX}${START_HEX}${HAN_HEX}${END_HEX}`,
    );
  });

  // ------------------------------------------------------------------
  // 4. Paste BEFORE compositionstart — then normal IME path follows.
  //    This is the "interleaved but not nested" case.
  // ------------------------------------------------------------------
  it('paste then composition (bracketed ON): paste wrapped, subsequent commit wrapped, no interference', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut, handle } = harness;

    dispatchPaste(container, 'Y');
    expect(handle.state().kind).toBe('Idle');

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));

    expect(hex(bytesOut)).toBe(
      `${START_HEX}59${END_HEX}${START_HEX}${HAN_HEX}${END_HEX}`,
    );
    expect(handle.state().kind).toBe('Idle');
  });

  // ------------------------------------------------------------------
  // 5. compositionend immediately followed by paste — no nesting, two
  //    distinct encoder calls, two distinct sentinel-wrapped emissions.
  // ------------------------------------------------------------------
  it('commit then paste (bracketed ON): two independent sentinel pairs, no overlap', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut } = harness;

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    dispatchPaste(container, 'Z');

    // Commit emission + paste emission, each fully bracketed.
    expect(bytesOut.length).toBe(2);
    expect(hex([bytesOut[0]!])).toBe(`${START_HEX}${HAN_HEX}${END_HEX}`);
    expect(hex([bytesOut[1]!])).toBe(`${START_HEX}5a${END_HEX}`); // 'Z' = 0x5a
  });

  // ------------------------------------------------------------------
  // 6. Paste payload containing an embedded end-sentinel — must be
  //    stripped by `Paste.encode()` before the outer wrap so a malicious
  //    clipboard cannot forge an early end. See Paste.ts
  //    `stripEmbeddedSentinels`.
  // ------------------------------------------------------------------
  it('paste payload containing ESC[201~ sentinel is stripped before wrapping', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut } = harness;

    // Payload = 'A' + ESC[201~ + 'B'. Build via String.fromCharCode so the
    // test source is ESC-free (check-ui-no-ansi rule). 0x1b = ESC.
    const payload =
      'A' +
      String.fromCharCode(0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e) +
      'B';
    dispatchPaste(container, payload);

    expect(bytesOut.length).toBe(1);
    // Output = START + 'A' + 'B' + END (the embedded END sentinel stripped).
    expect(hex(bytesOut)).toBe(`${START_HEX}4142${END_HEX}`);
  });

  it('paste payload containing ESC[200~ sentinel is stripped too', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut } = harness;

    const payload =
      'a' +
      String.fromCharCode(0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e) +
      'b';
    dispatchPaste(container, payload);

    expect(bytesOut.length).toBe(1);
    expect(hex(bytesOut)).toBe(`${START_HEX}6162${END_HEX}`); // START a b END
  });

  // ------------------------------------------------------------------
  // 7. Empty paste while Composing — IME state untouched, no paste bytes
  //    (Paste encoder emits zero-length; input-host skips the emit).
  // ------------------------------------------------------------------
  it('empty paste during Composing does not perturb IME state and emits no paste bytes', () => {
    harness = makeHarness({ bracketedPaste: false });
    const { container, bytesOut, handle } = harness;

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));

    const before = bytesOut.length;
    dispatchPaste(container, '');
    // input-host guards on `out.bytes.length > 0` — empty paste, no emit.
    expect(bytesOut.length).toBe(before);
    expect(handle.state().kind).toBe('Composing');

    // Finishing the composition still commits correctly.
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    expect(hex(bytesOut)).toBe(HAN_HEX);
  });

  // ------------------------------------------------------------------
  // 8. Mode snapshot is captured at encode-time. ADR 0018 and EPIC-E
  //    guarantee that a `Paste.encode()` call reads the mode once per
  //    call and uses that for the duration of the encode. The test
  //    flips bracketedPaste between two dispatches to observe the
  //    "before" paste used the old mode and the "after" paste used the
  //    new mode.
  // ------------------------------------------------------------------
  it('mode flips between paste events: each paste uses the mode as-of its own encode', () => {
    harness = makeHarness({ bracketedPaste: false });
    const { container, bytesOut, mirror } = harness;

    dispatchPaste(container, 'p'); // mode=OFF at this moment
    mirror.applyMode({ bracketedPaste: true });
    dispatchPaste(container, 'q'); // mode=ON at this moment

    expect(bytesOut.length).toBe(2);
    expect(hex([bytesOut[0]!])).toBe('70'); // unwrapped 'p'
    expect(hex([bytesOut[1]!])).toBe(`${START_HEX}71${END_HEX}`); // wrapped 'q'
  });

  // ------------------------------------------------------------------
  // 9. Bracketed paste flipped OFF mid-composition — the commit re-reads
  //    the snapshot at commit time (the state machine does not freeze
  //    the mode at compositionstart). This pins the observed behavior.
  // ------------------------------------------------------------------
  it('bracketedPaste flipped OFF between compositionstart and commit → commit is NOT wrapped', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut, mirror } = harness;

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    // Host flips DECRST 2004 mid-composition.
    mirror.applyMode({ bracketedPaste: false });
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));

    // Commit encoded with mode = OFF at encode time.
    expect(hex(bytesOut)).toBe(HAN_HEX);
  });

  // ------------------------------------------------------------------
  // 10. Large paste (10 KB) — single emit, sentinels at boundaries
  //     exactly once, payload verbatim in the middle.
  // ------------------------------------------------------------------
  it('large paste (10 KB, bracketed ON) → single emit with one START + payload + one END', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut } = harness;

    const payload = 'a'.repeat(10_000);
    dispatchPaste(container, payload);

    expect(bytesOut.length).toBe(1);
    const combined = bytesOut[0]!;
    // 6 bytes of START + 10000 bytes + 6 bytes of END.
    expect(combined.length).toBe(6 + 10_000 + 6);
    // First 6 bytes are the START sentinel.
    expect(Array.from(combined.slice(0, 6))).toEqual([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);
    // Last 6 bytes are the END sentinel.
    expect(Array.from(combined.slice(-6))).toEqual([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);
    // Body is all 0x61 ('a').
    for (let i = 6; i < combined.length - 6; i++) {
      if (combined[i] !== 0x61) {
        throw new Error(`byte ${i} = ${combined[i]} (expected 0x61)`);
      }
    }
  });

  // ------------------------------------------------------------------
  // 11. compositionupdate during a paste-in-flight cannot happen in the
  //     synchronous DOM model — the paste encoder is fully synchronous
  //     — but we can still verify that a compositionstart occurring
  //     AFTER a paste does not retroactively wrap or alter the already-
  //     emitted paste chunk. Byte immutability once emitted.
  // ------------------------------------------------------------------
  it('compositionstart after paste does not mutate already-emitted paste bytes', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut } = harness;

    dispatchPaste(container, 'ok');
    expect(bytesOut.length).toBe(1);
    const firstChunk = bytesOut[0]!;
    const firstHex = hex([firstChunk]);

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));

    // The previously emitted chunk is unchanged (encoder returns fresh
    // Uint8Arrays and input-host pushes them without later mutation).
    expect(hex([firstChunk])).toBe(firstHex);
    // No new bytes from compositionstart/update (I-1, I-2, I-7).
    expect(bytesOut.length).toBe(1);
  });

  // ------------------------------------------------------------------
  // 12. IME cancel (Esc) while bracketed paste ON — no commit bytes
  //     emitted, and therefore no sentinel pair emitted either.
  //     Guards against a leak where an aborted composition might still
  //     open a bracketed-paste window.
  // ------------------------------------------------------------------
  it('Esc-cancel while bracketed ON emits no bytes (no dangling sentinel window)', () => {
    harness = makeHarness({ bracketedPaste: true });
    const { container, bytesOut, handle } = harness;

    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );

    expect(bytesOut.length).toBe(0);
    expect(handle.state().kind).toBe('Idle');
  });
});
