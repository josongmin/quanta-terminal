/**
 * Plan 0005 P0 audit follow-up — F1..F12 under every encoding mode.
 *
 * Scope: this file pins the EXACT wire bytes for the common function
 * keys across the four encoding lanes:
 *
 *   • legacy (xterm PC-style)
 *   • modify-other-keys=1 (ambiguous-only; F-keys are NOT ambiguous)
 *   • modify-other-keys=2 (all-printables; F-keys still delegate to
 *     legacy per the encoder's implementation)
 *   • kitty-1 (`ESC_BRK <kc> ; <mod> u` using kitty's keycode table)
 *
 * Why this matters beyond the fixture matrix
 * ------------------------------------------
 * `input-matrix.json` has F1..F12 under legacy + mkeys-2 + kitty-1 but
 * covers only a subset of the modifier combinations, and only the named
 * modes. This file adds:
 *
 *   • Modified (Shift / Ctrl / Alt / combos) forms for F1..F4 — the
 *     `ESC O 1 ; <mod> <P..S>` branch — which no other test anchors by
 *     hex string.
 *   • Modified forms for F5..F12 tilde codes.
 *   • The mkeys=1 path for F-keys: §3.3 rules state "non-ambiguous keys
 *     stay on legacy"; this file proves F-keys fall through.
 *   • The kitty-1 keycode table for F5..F7 vs F8..F12 (non-contiguous
 *     assignment per the spec) — catches any future regression that
 *     flattens them.
 *
 * Agent R's `keystroke-encoding-edge-cases.test.ts` covers F13..F24 in
 * legacy mode; do NOT duplicate those here.
 */
import { describe, expect, it } from 'vitest';

import { encodeKitty } from '../encoders/kitty';
import { encodeLegacy } from '../encoders/legacy';
import { encodeModifyOtherKeysV1 } from '../encoders/modify-other-keys-v1';
import { encodeModifyOtherKeysV2 } from '../encoders/modify-other-keys-v2';
import type { KeyEvent, TerminalModeSnapshot } from '../types';

function mkEvent(partial: Partial<KeyEvent> & { key: string }): KeyEvent {
  return {
    code: partial.key,
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

describe('audit §fkey.1 — F1..F4 unmodified (legacy SS3 final letters P Q R S)', () => {
  // Each F-key in 1..4 routes through ESC O <P|Q|R|S>. Anchored so
  // any drift in the F1_F4_FINAL table is caught immediately.
  const cases: Array<[string, string]> = [
    ['F1', '1b4f50'],
    ['F2', '1b4f51'],
    ['F3', '1b4f52'],
    ['F4', '1b4f53'],
  ];
  for (const [key, hex] of cases) {
    it(`${key} (legacy, unmodified) → ${hex}`, () => {
      const out = encodeLegacy(mkEvent({ key }), mkSnap());
      expect(toHex(out)).toBe(hex);
    });
  }
});

describe('audit §fkey.2 — F5..F12 unmodified (legacy CSI tilde codes)', () => {
  // xterm's F5..F12 table has a GAP at F7→F8 (18→19 skips nothing,
  // but 19→20 is there and 20→21→23 drops 22). This test pins the
  // exact `code ~` shape for each.
  const cases: Array<[string, number]> = [
    ['F5', 15],
    ['F6', 17],
    ['F7', 18],
    ['F8', 19],
    ['F9', 20],
    ['F10', 21],
    ['F11', 23],
    ['F12', 24],
  ];
  for (const [key, code] of cases) {
    it(`${key} (legacy, unmodified) → ESC [ ${code} ~`, () => {
      const out = encodeLegacy(mkEvent({ key }), mkSnap());
      const digits = String(code)
        .split('')
        .map((d) => d.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
      expect(toHex(out)).toBe(`1b5b${digits}7e`);
    });
  }
});

describe('audit §fkey.3 — modified F1..F4 (legacy ESC O 1 ; <mod> <final>)', () => {
  // Shift+F1 → ESC O 1 ; 2 P. No matrix case pins this form by hex.
  it('Shift+F1 → ESC O 1 ; 2 P', () => {
    const out = encodeLegacy(
      mkEvent({ key: 'F1', shiftKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b4f313b3250'); // ESC O 1 ; 2 P
  });

  it('Ctrl+F4 → ESC O 1 ; 5 S', () => {
    const out = encodeLegacy(
      mkEvent({ key: 'F4', ctrlKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b4f313b3553'); // ESC O 1 ; 5 S
  });

  it('Ctrl+Shift+Alt+F2 → ESC O 1 ; 8 Q', () => {
    // Triple-modifier sanity — 1|2|4+1 = 8.
    const out = encodeLegacy(
      mkEvent({ key: 'F2', ctrlKey: true, shiftKey: true, altKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b4f313b3851');
  });
});

describe('audit §fkey.4 — modified F5..F12 (legacy ESC [ <code> ; <mod> ~)', () => {
  it('Shift+F5 → ESC [ 15 ; 2 ~', () => {
    const out = encodeLegacy(
      mkEvent({ key: 'F5', shiftKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b5b31353b327e');
  });

  it('Ctrl+F10 → ESC [ 21 ; 5 ~', () => {
    const out = encodeLegacy(
      mkEvent({ key: 'F10', ctrlKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b5b32313b357e');
  });

  it('Alt+F12 → ESC [ 24 ; 3 ~', () => {
    const out = encodeLegacy(
      mkEvent({ key: 'F12', altKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b5b32343b337e');
  });
});

describe('audit §fkey.5 — F-keys under modifyOtherKeys=1 (delegated to legacy)', () => {
  // mkeys-1 only promotes Tab/Enter/Escape/Backspace (the ambiguous
  // four) to CSI-27 form when modified. F-keys are NON-ambiguous, so
  // they must stay on the legacy byte shape verbatim.
  it('F1 unmodified under mkeys-1 → legacy ESC O P', () => {
    const out = encodeModifyOtherKeysV1(mkEvent({ key: 'F1' }), mkSnap({ modifyOtherKeys: 1 }));
    expect(toHex(out)).toBe('1b4f50');
  });

  it('Ctrl+F5 under mkeys-1 → legacy ESC [ 15 ; 5 ~ (not CSI-27)', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'F5', ctrlKey: true }),
      mkSnap({ modifyOtherKeys: 1 }),
    );
    expect(toHex(out)).toBe('1b5b31353b357e');
  });
});

describe('audit §fkey.6 — F-keys under modifyOtherKeys=2 (still legacy-shaped)', () => {
  // §3.3 notes "cursor / function / special keys delegate to legacy"
  // even under mkeys-2. The CSI-27 path is printable-only.
  it('F3 unmodified under mkeys-2 → legacy ESC O R', () => {
    const out = encodeModifyOtherKeysV2(mkEvent({ key: 'F3' }), mkSnap({ modifyOtherKeys: 2 }));
    expect(toHex(out)).toBe('1b4f52');
  });

  it('Alt+F7 under mkeys-2 → legacy ESC [ 18 ; 3 ~', () => {
    const out = encodeModifyOtherKeysV2(
      mkEvent({ key: 'F7', altKey: true }),
      mkSnap({ modifyOtherKeys: 2 }),
    );
    expect(toHex(out)).toBe('1b5b31383b337e');
  });
});

describe('audit §fkey.7 — kitty L1 F1..F7 keycodes 57364..57370 (contiguous)', () => {
  // kitty's FN table has F1..F7 at 57364..57370, then a GAP (57371/72
  // belong to Home/End), with F8..F12 picking up at 57373..57377.
  // Anchoring each hex catches both a table-drift regression AND an
  // off-by-one on the keycode.
  const cases: Array<[string, number]> = [
    ['F1', 57364],
    ['F2', 57365],
    ['F3', 57366],
    ['F4', 57367],
    ['F5', 57368],
    ['F6', 57369],
    ['F7', 57370],
  ];
  for (const [key, code] of cases) {
    it(`${key} (kitty-1, unmodified) → ESC [ ${code} ; 1 u`, () => {
      const out = encodeKitty(
        mkEvent({ key }),
        mkSnap({ kittyKeyboard: 1 }),
        1,
      );
      // Expected bytes: ESC [ <code-as-decimal-digits> ; 1 u
      const codeHex = String(code)
        .split('')
        .map((d) => d.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
      expect(toHex(out)).toBe(`1b5b${codeHex}3b3175`);
    });
  }
});

describe('audit §fkey.8 — kitty L1 F8..F12 keycodes 57373..57377 (after the gap)', () => {
  const cases: Array<[string, number]> = [
    ['F8', 57373],
    ['F9', 57374],
    ['F10', 57375],
    ['F11', 57376],
    ['F12', 57377],
  ];
  for (const [key, code] of cases) {
    it(`${key} (kitty-1, unmodified) → ESC [ ${code} ; 1 u`, () => {
      const out = encodeKitty(
        mkEvent({ key }),
        mkSnap({ kittyKeyboard: 1 }),
        1,
      );
      const codeHex = String(code)
        .split('')
        .map((d) => d.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
      expect(toHex(out)).toBe(`1b5b${codeHex}3b3175`);
    });
  }
});

describe('audit §fkey.9 — kitty L2 F-key event-kind suffixes', () => {
  it('F1 keyup under kitty-2 appends ;3 → ESC [ 57364 ; 1 ; 3 u', () => {
    // L2's release form matches the named-key table same as letters.
    const out = encodeKitty(
      mkEvent({ key: 'F1', kind: 'keyup' }),
      mkSnap({ kittyKeyboard: 2 }),
      2,
    );
    expect(toHex(out)).toBe('1b5b35373336343b313b3375');
  });

  it('F8 keydown-repeat under kitty-2 appends ;2 → ESC [ 57373 ; 1 ; 2 u', () => {
    const out = encodeKitty(
      mkEvent({ key: 'F8', repeat: true }),
      mkSnap({ kittyKeyboard: 2 }),
      2,
    );
    expect(toHex(out)).toBe('1b5b35373337333b313b3275');
  });
});

describe('audit §fkey.10 — kitty L1 Shift+F1 → ESC [ 57364 ; 2 u (modifier carries)', () => {
  it('Shift+F1 kitty-1 = ESC [ 57364 ; 2 u', () => {
    const out = encodeKitty(
      mkEvent({ key: 'F1', shiftKey: true }),
      mkSnap({ kittyKeyboard: 1 }),
      1,
    );
    expect(toHex(out)).toBe('1b5b35373336343b3275');
  });

  it('Ctrl+Alt+F12 kitty-1 = ESC [ 57377 ; 7 u', () => {
    // kitty modifier for ctrl+alt: (2|4)+1 = 7.
    const out = encodeKitty(
      mkEvent({ key: 'F12', ctrlKey: true, altKey: true }),
      mkSnap({ kittyKeyboard: 1 }),
      1,
    );
    expect(toHex(out)).toBe('1b5b35373337373b3775');
  });
});
