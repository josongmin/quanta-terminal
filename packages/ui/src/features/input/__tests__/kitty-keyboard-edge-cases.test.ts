/**
 * Plan 0005 P0 audit follow-up — Kitty keyboard protocol edge cases
 * that the wire-level encoder does NOT currently own but that the
 * engine-side mode mirror eventually will, plus the bits the encoder
 * DOES own (level selection, clamp behavior, event-kind suffix rules).
 *
 * Kitty's full push/pop/set protocol is:
 *
 *   CSI = <flags> u      → set the top-of-stack flags (replace).
 *   CSI > <flags> u      → push a new frame onto the stack with flags.
 *   CSI < [n] u          → pop `n` (default 1) frames off the stack.
 *   CSI ? u              → query current (top-of-stack) flags; the
 *                           emulator replies with `CSI ? <flags> u`.
 *
 * None of those are implemented in `features/input` today — the encoder
 * reads a single `kittyKeyboard: 0|1|2|3` level from the mode snapshot
 * and emits accordingly. The stack semantics live in the VT engine
 * (`packages/vtengine`), which is Agent X's scope — out of scope here.
 *
 * What this file verifies is therefore the INPUT-ENCODER contract on
 * the values the mirror DOES surface:
 *
 *   • Every supported level (1, 2, 3) routes through the kitty encoder.
 *   • Out-of-range values (>3, e.g. from a future level-4/5 negotiation)
 *     clamp to kitty-3 and set `deprecatedFallback=true`.
 *   • "Back to zero" (a pop that takes the stack to empty → level 0)
 *     routes back to the LEGACY encoder, not kitty.
 *   • Mode flips between reads are observable via `modeReadInconsistency`
 *     (the engine's ModeChanged bump).
 *
 * When the engine lands the real stack (§ adrs/0019-kitty-stack.md,
 * forthcoming), the push/pop/set tests in `packages/vtengine/__tests__/`
 * will pin the stack behavior; THIS file will keep pinning the encoder
 * path downstream of it.
 *
 * TODO(EPIC-C §kitty-stack): once the VT engine exposes a kitty flag
 * stack, add cross-layer tests that drive push/pop/set parse events
 * through the engine and assert `ModeSnapshot.read().kittyKeyboard`
 * reflects the new top.
 */
import { describe, expect, it } from 'vitest';

import { KeyEncoder, selectEncodingMode } from '../KeyEncoder';
import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import type { KeyEvent, TerminalModeSnapshot } from '../types';

function mkEvent(partial: Partial<KeyEvent> & { key: string }): KeyEvent {
  return {
    code: '',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...partial,
  };
}

function mkSnap(
  partial: Partial<Omit<TerminalModeSnapshot, 'snapshotEpoch'>> = {},
): TerminalModeSnapshot {
  return Object.freeze({
    decckm: false,
    bracketedPaste: false,
    focusReporting: false,
    mouseTracking: 'off' as const,
    mouseEncoding: 'default' as const,
    modifyOtherKeys: 0 as const,
    kittyKeyboard: 0 as const,
    altScreen: false,
    synchronizedUpdate: false,
    snapshotEpoch: 0n,
    ...partial,
  });
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

describe('audit §kitty.1 — level selection via `selectEncodingMode`', () => {
  it('kittyKeyboard=1 selects kitty-1 with no fallback', () => {
    const { mode, deprecatedFallback } = selectEncodingMode(mkSnap({ kittyKeyboard: 1 }));
    expect(mode).toBe('kitty-1');
    expect(deprecatedFallback).toBe(false);
  });

  it('kittyKeyboard=2 selects kitty-2 with no fallback', () => {
    const { mode, deprecatedFallback } = selectEncodingMode(mkSnap({ kittyKeyboard: 2 }));
    expect(mode).toBe('kitty-2');
    expect(deprecatedFallback).toBe(false);
  });

  it('kittyKeyboard=3 selects kitty-3 with no fallback', () => {
    const { mode, deprecatedFallback } = selectEncodingMode(mkSnap({ kittyKeyboard: 3 }));
    expect(mode).toBe('kitty-3');
    expect(deprecatedFallback).toBe(false);
  });

  it('kittyKeyboard=0 selects legacy (stack bottom / unset)', () => {
    const { mode } = selectEncodingMode(mkSnap({ kittyKeyboard: 0 }));
    expect(mode).toBe('legacy');
  });
});

describe('audit §kitty.2 — overflow / future-level clamping', () => {
  it('kittyKeyboard=4 clamps to kitty-3 with deprecatedFallback=true', () => {
    // Level 4/5 are in the kitty spec but not yet supported by the encoder.
    // The dispatcher treats them as "future" levels and falls back to L3.
    const raw = mkSnap({
      kittyKeyboard: 4 as unknown as TerminalModeSnapshot['kittyKeyboard'],
    });
    const { mode, deprecatedFallback } = selectEncodingMode(raw);
    expect(mode).toBe('kitty-3');
    expect(deprecatedFallback).toBe(true);
  });

  it('kittyKeyboard=99 still clamps to kitty-3 with deprecatedFallback=true', () => {
    // Defensive: if some future CSI > <huge> u somehow bypassed engine
    // validation, the encoder must still produce SOMETHING sensible.
    const raw = mkSnap({
      kittyKeyboard: 99 as unknown as TerminalModeSnapshot['kittyKeyboard'],
    });
    const { mode, deprecatedFallback } = selectEncodingMode(raw);
    expect(mode).toBe('kitty-3');
    expect(deprecatedFallback).toBe(true);
  });
});

describe('audit §kitty.3 — mode flip between reads (push/pop/set analog)', () => {
  it('a mode bump between read() and peekEpoch() surfaces modeReadInconsistency', () => {
    // Simulates the race that a kitty `CSI > 1 u` push would create: the
    // engine commits the new top-of-stack between our snapshot read and
    // the peek at encode end. We do not have a stack to push/pop yet, but
    // the mirror bumps `appliedEpoch` on any ModeChanged, which is the
    // mechanism a stack-aware mirror would use.
    const mirror = createStubMirror({ kittyKeyboard: 1 });
    const reader = new ModeSnapshot(mirror);
    const snap = reader.read();
    // Engine "pops" the frame, returning to the bottom (kittyKeyboard=0).
    mirror.applyMode({ kittyKeyboard: 0 });
    const encoder = new KeyEncoder({ modeSnapshot: reader });
    const out = encoder.encode(mkEvent({ key: 'a', code: 'KeyA' }), snap);
    expect(out.diagnostics.modeReadInconsistency).toBe(true);
  });

  it('three sequential mode changes each bump the epoch (stack push depth 3 analog)', () => {
    // TODO(EPIC-C §kitty-stack): when the engine exposes a flag stack,
    // swap these applyMode calls for push/pop parse events and assert
    // the top-of-stack value.
    const mirror = createStubMirror({ kittyKeyboard: 0 });
    const r = new ModeSnapshot(mirror);
    const e0 = r.peekEpoch();
    mirror.applyMode({ kittyKeyboard: 1 }); // push #1
    const e1 = r.peekEpoch();
    mirror.applyMode({ kittyKeyboard: 2 }); // push #2
    const e2 = r.peekEpoch();
    mirror.applyMode({ kittyKeyboard: 3 }); // push #3
    const e3 = r.peekEpoch();
    expect(e1).toBe(e0 + 1n);
    expect(e2).toBe(e0 + 2n);
    expect(e3).toBe(e0 + 3n);
  });

  it('pop-to-zero routes back to the legacy encoder (not kitty)', () => {
    // Common kitty lifecycle: a program pushed L3, then exits (or the
    // user issues reset-terminal). The mirror drops back to 0 and the
    // encoder MUST revert to the legacy form — not accidentally linger
    // in kitty mode. Verified via byte shape.
    const mirror = createStubMirror({ kittyKeyboard: 3 });
    const reader = new ModeSnapshot(mirror);
    const encoder = new KeyEncoder({ modeSnapshot: reader });
    const kittyOut = encoder.encode(mkEvent({ key: 'a', code: 'KeyA' }));
    expect(toHex(kittyOut.bytes)).toBe('1b5b39373b3175'); // ESC [ 97 ; 1 u
    mirror.applyMode({ kittyKeyboard: 0 });
    const legacyOut = encoder.encode(mkEvent({ key: 'a', code: 'KeyA' }));
    expect(toHex(legacyOut.bytes)).toBe('61'); // plain 'a'
  });
});

describe('audit §kitty.4 — level precedence over modifyOtherKeys', () => {
  it('kittyKeyboard=1 + modifyOtherKeys=2 selects kitty-1 (kitty wins)', () => {
    // §3.1 precedence: kitty beats mkeys, mkeys beats legacy. A program
    // that enabled BOTH kitty-1 and mkeys-2 gets kitty; the encoder
    // never emits the CSI 27 form under an active kitty frame.
    const { mode } = selectEncodingMode(mkSnap({ kittyKeyboard: 1, modifyOtherKeys: 2 }));
    expect(mode).toBe('kitty-1');
  });

  it('dropping kittyKeyboard to 0 exposes the still-active mkeys-2 frame', () => {
    // Mirror scenario: the kitty program pops its frame, but the
    // ENCOMPASSING mkeys frame is still set (legitimate stacking in
    // tmux/screen). The encoder must switch to mkeys-2 not legacy.
    const { mode } = selectEncodingMode(mkSnap({ kittyKeyboard: 0, modifyOtherKeys: 2 }));
    expect(mode).toBe('modify-other-keys-v2');
  });
});

describe('audit §kitty.5 — event-kind suffix semantics carry-over', () => {
  it('the selected level is stable WITHIN a single encode() call', () => {
    // Regression guard: if a race mutated kittyKeyboard mid-encode the
    // output could be a half-kitty / half-legacy frankenbyte. The
    // snapshot read is one-shot and deep-frozen, so we should only ever
    // see one encoding shape per event.
    const mirror = createStubMirror({ kittyKeyboard: 2 });
    const reader = new ModeSnapshot(mirror);
    const encoder = new KeyEncoder({ modeSnapshot: reader });
    // Read snapshot explicitly, then mutate AFTER — the encode call
    // should still use the frozen snap.
    const snap = reader.read();
    mirror.applyMode({ kittyKeyboard: 0 });
    const out = encoder.encode(mkEvent({ key: 'a', code: 'KeyA' }), snap);
    // Byte shape is the kitty one (ESC [ 97 ; 1 u) — proof the frozen
    // snap was honored. The modeReadInconsistency flag fires to tell
    // the caller a re-read is warranted.
    expect(toHex(out.bytes)).toBe('1b5b39373b3175');
    expect(out.diagnostics.modeReadInconsistency).toBe(true);
  });
});
