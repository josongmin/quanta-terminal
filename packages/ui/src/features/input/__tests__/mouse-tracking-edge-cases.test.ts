/**
 * Plan 0005 P0 audit — mouse tracking edge cases.
 *
 * Gaps in the existing `MouseEncoder.test.ts`:
 *   - x10 tracking only allows press. Tests cover press/release but not
 *     motion or drag (which must be silently dropped).
 *   - button_event (1002) must emit drag events. Fine today, but no test
 *     ever proves it drops the no-button hover-move — easy regression.
 *   - any_event (1003) with `release` has no ordering test.
 *   - "Modifier OR'd into Cb on wheel" under any_event.
 *   - Release event with a button code 1/2 (middle/right) — verify the
 *     <Cb> carries the actual button, not 0.
 *   - Drag sequence preserves per-event emissions (no dedupe at encoder
 *     level).
 *   - mouseEncoding='utf8' / 'url_xterm' fall back to default with
 *     `deprecatedFallback=true`.
 *
 * Byte layout is `ESC [ < Cb ; X ; Y (M|m)`, X/Y 1-based.
 */
import { describe, expect, it } from 'vitest';

import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import { MouseEncoder } from '../MouseEncoder';
import type { MouseEvent, TerminalModeSnapshot } from '../types';

const NO_MODS = { ctrl: false, alt: false, shift: false, meta: false };

function snap(
  overrides: Partial<Omit<TerminalModeSnapshot, 'snapshotEpoch'>> = {},
): TerminalModeSnapshot {
  return Object.freeze({
    decckm: false,
    bracketedPaste: false,
    focusReporting: false,
    mouseTracking: 'button_event' as const,
    mouseEncoding: 'sgr' as const,
    modifyOtherKeys: 0 as const,
    kittyKeyboard: 0 as const,
    altScreen: false,
    synchronizedUpdate: false,
    snapshotEpoch: 0n,
    ...overrides,
  });
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

function enc(
  ev: MouseEvent,
  overrides: Partial<Omit<TerminalModeSnapshot, 'snapshotEpoch'>> = {},
): Uint8Array {
  const mouseEncoder = new MouseEncoder({
    modeSnapshot: new ModeSnapshot(createStubMirror()),
  });
  const out = mouseEncoder.encode(ev, snap(overrides));
  return out.bytes;
}

// ---------------------------------------------------------------------------
// §2.1 x10 tracking rejects drag / move / release
// ---------------------------------------------------------------------------
describe('audit §2.1 — x10 (DECSET 1000) rejects non-press events', () => {
  it('x10 drag → 0 bytes', () => {
    /**
     * x10 emits press-only. The `if (event.kind !== 'press') return
     * empty` guard must catch drag/move/release equally. No test existed
     * for drag under x10.
     */
    const out = enc(
      {
        xCell: 3,
        yCell: 5,
        button: 'left',
        modifiers: NO_MODS,
        kind: 'drag',
      },
      { mouseTracking: 'x10' },
    );
    expect(out.length).toBe(0);
  });

  it('x10 move (no button) → 0 bytes', () => {
    const out = enc(
      { xCell: 3, yCell: 5, button: 'none', modifiers: NO_MODS, kind: 'move' },
      { mouseTracking: 'x10' },
    );
    expect(out.length).toBe(0);
  });

  it('x10 wheel → 0 bytes (wheel is not a press)', () => {
    /**
     * Wheel events have `kind: 'wheel'`, not `'press'`. They must not
     * fall through to a spurious press-press encoding under x10.
     */
    const out = enc(
      {
        xCell: 3,
        yCell: 5,
        button: 'wheel-up',
        modifiers: NO_MODS,
        kind: 'wheel',
      },
      { mouseTracking: 'x10' },
    );
    expect(out.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §2.2 button_event drops hover-move but preserves drag
// ---------------------------------------------------------------------------
describe('audit §2.2 — button_event (DECSET 1002) allows drag, drops hover-move', () => {
  it('button_event drag → ESC [ < 32 ; X ; Y M (left drag)', () => {
    const out = enc({
      xCell: 10,
      yCell: 10,
      button: 'left',
      modifiers: NO_MODS,
      kind: 'drag',
    });
    expect(toHex(out)).toBe('1b5b3c33323b31313b31314d');
  });

  it('button_event hover-move (button=none) → 0 bytes', () => {
    /**
     * The hover-move gate is critical: running a full-screen app in
     * button_event mode MUST NOT flood the wire with no-button moves.
     */
    const out = enc({
      xCell: 10,
      yCell: 10,
      button: 'none',
      modifiers: NO_MODS,
      kind: 'move',
    });
    expect(out.length).toBe(0);
  });

  it('button_event wheel is encoded (wheel is tracking-only, not click-only)', () => {
    const out = enc({
      xCell: 0,
      yCell: 0,
      button: 'wheel-up',
      modifiers: NO_MODS,
      kind: 'wheel',
    });
    expect(out.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §2.3 any_event passes hover-move
// ---------------------------------------------------------------------------
describe('audit §2.3 — any_event (DECSET 1003) emits hover-move', () => {
  it('any_event move (button=none) → ESC [ < 35 ; X ; Y M', () => {
    /**
     * `buildCb` special-cases move+none → 35 (drag-form-plus-no-button).
     * Pinning the exact byte stream.
     */
    const out = enc(
      { xCell: 7, yCell: 3, button: 'none', modifiers: NO_MODS, kind: 'move' },
      { mouseTracking: 'any_event' },
    );
    // ESC [ < 3 5 ; 8 ; 4 M
    expect(toHex(out)).toBe('1b5b3c33353b383b344d');
  });

  it('any_event ctrl+hover → cb=35+16=51 (modifier or-ins apply to hover)', () => {
    /** Ctrl+motion in any_event mode must include the ctrl bit. */
    const out = enc(
      {
        xCell: 0,
        yCell: 0,
        button: 'none',
        modifiers: { ...NO_MODS, ctrl: true },
        kind: 'move',
      },
      { mouseTracking: 'any_event' },
    );
    expect(toHex(out)).toBe('1b5b3c35313b313b314d'); // cb=51
  });
});

// ---------------------------------------------------------------------------
// §2.4 Release carries button bits
// ---------------------------------------------------------------------------
describe('audit §2.4 — release terminator `m` with correct button code', () => {
  /**
   * SGR 1006 release emits the SAME <Cb> as the corresponding press but
   * with a lowercase `m` terminator. This lets apps correlate press ↔
   * release across all three buttons.
   */
  it('middle button release → ESC [ < 1 ; X ; Y m', () => {
    const out = enc({
      xCell: 3,
      yCell: 5,
      button: 'middle',
      modifiers: NO_MODS,
      kind: 'release',
    });
    expect(toHex(out)).toBe('1b5b3c313b343b366d');
  });

  it('right button release → ESC [ < 2 ; X ; Y m', () => {
    const out = enc({
      xCell: 3,
      yCell: 5,
      button: 'right',
      modifiers: NO_MODS,
      kind: 'release',
    });
    expect(toHex(out)).toBe('1b5b3c323b343b366d');
  });

  it('shift+left release → ESC [ < 4 ; X ; Y m (shift bit preserved)', () => {
    const out = enc({
      xCell: 0,
      yCell: 0,
      button: 'left',
      modifiers: { ...NO_MODS, shift: true },
      kind: 'release',
    });
    expect(toHex(out)).toBe('1b5b3c343b313b316d');
  });
});

// ---------------------------------------------------------------------------
// §2.5 Drag across buffer emits every event (no dedupe)
// ---------------------------------------------------------------------------
describe('audit §2.5 — encoder never dedupes consecutive motion events', () => {
  /**
   * The encoder is stateless. A drag path of 1 press + 3 drags + 1
   * release should yield 5 distinct byte sequences, each with its own
   * coordinates. This pins the invariant against a future micro-
   * optimization that might coalesce identical moves.
   */
  it('press → drag → drag → drag → release produces 5 distinct byte strings', () => {
    const events: MouseEvent[] = [
      { xCell: 1, yCell: 1, button: 'left', modifiers: NO_MODS, kind: 'press' },
      { xCell: 2, yCell: 1, button: 'left', modifiers: NO_MODS, kind: 'drag' },
      { xCell: 3, yCell: 1, button: 'left', modifiers: NO_MODS, kind: 'drag' },
      { xCell: 4, yCell: 1, button: 'left', modifiers: NO_MODS, kind: 'drag' },
      {
        xCell: 4,
        yCell: 1,
        button: 'left',
        modifiers: NO_MODS,
        kind: 'release',
      },
    ];
    const results = events.map((e) => toHex(enc(e)));
    expect(new Set(results).size).toBe(5);
    // Press uses cb=0, terminator M.
    expect(results[0]).toBe('1b5b3c303b323b324d');
    // Drags use cb=32 (drag-form for left).
    expect(results[1]).toBe('1b5b3c33323b333b324d');
    expect(results[2]).toBe('1b5b3c33323b343b324d');
    expect(results[3]).toBe('1b5b3c33323b353b324d');
    // Release uses cb=0, terminator m.
    expect(results[4]).toBe('1b5b3c303b353b326d');
  });

  it('two identical drags still emit two identical byte strings (no suppression)', () => {
    const ev: MouseEvent = {
      xCell: 5,
      yCell: 5,
      button: 'left',
      modifiers: NO_MODS,
      kind: 'drag',
    };
    const a = toHex(enc(ev));
    const b = toHex(enc(ev));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §2.6 Non-SGR encoding degrades with deprecatedFallback=true
// ---------------------------------------------------------------------------
describe('audit §2.6 — non-SGR mouseEncoding degrades with diagnostic flag', () => {
  it('mouseEncoding=utf8 emits 0 bytes with deprecatedFallback=true', () => {
    /**
     * Only SGR (1006) and the `default` seed are supported in v1. UTF-8
     * (1005) and urxvt (1015) fall back gracefully — the encoder MUST
     * NOT attempt to emit legacy-1000 bytes because the input-host
     * contract doesn't know how.
     */
    const mouseEncoder = new MouseEncoder({
      modeSnapshot: new ModeSnapshot(createStubMirror()),
    });
    const out = mouseEncoder.encode(
      {
        xCell: 3,
        yCell: 5,
        button: 'left',
        modifiers: NO_MODS,
        kind: 'press',
      },
      snap({ mouseEncoding: 'utf8' }),
    );
    expect(out.bytes.length).toBe(0);
    expect(out.diagnostics.deprecatedFallback).toBe(true);
  });

  it('mouseEncoding=url_xterm (urxvt) emits 0 bytes with deprecatedFallback=true', () => {
    const mouseEncoder = new MouseEncoder({
      modeSnapshot: new ModeSnapshot(createStubMirror()),
    });
    const out = mouseEncoder.encode(
      {
        xCell: 3,
        yCell: 5,
        button: 'left',
        modifiers: NO_MODS,
        kind: 'press',
      },
      snap({ mouseEncoding: 'url_xterm' }),
    );
    expect(out.bytes.length).toBe(0);
    expect(out.diagnostics.deprecatedFallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2.7 Coordinate invariants
// ---------------------------------------------------------------------------
describe('audit §2.7 — coordinate clamping and 1-based wire output', () => {
  it('origin (0, 0) encodes as 1 ; 1 (SGR 1-based)', () => {
    /** (0,0) cell → (1,1) wire — not (0,0). A common off-by-one slip. */
    const out = enc({
      xCell: 0,
      yCell: 0,
      button: 'left',
      modifiers: NO_MODS,
      kind: 'press',
    });
    // ESC [ < 0 ; 1 ; 1 M  →  1b 5b 3c 30 3b 31 3b 31 4d
    expect(toHex(out)).toBe('1b5b3c303b313b314d');
  });

  it('very large xCell passes through unclamped (caller owns upper bound)', () => {
    /**
     * The encoder does not know the grid dimensions; input-host clamps
     * via `screenToCell`. Pinning this makes the boundary explicit.
     */
    const out = enc({
      xCell: 99_999,
      yCell: 1,
      button: 'left',
      modifiers: NO_MODS,
      kind: 'press',
    });
    expect(toHex(out)).toContain('3130303030303b32'); // "100000;2" substring
  });
});
