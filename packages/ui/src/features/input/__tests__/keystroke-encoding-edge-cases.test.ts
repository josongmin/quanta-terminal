/**
 * Plan 0005 P0 audit — keystroke encoding edge cases that were not
 * previously covered by the `input-matrix.json` fixture (which pins
 * F1..F12 but not the extended F13..F24 row, omits Kitty L2 keyup/repeat
 * past a single spot-check, and contains no entry for the `numpad` /
 * `backtab` / `Ctrl+Shift+letter-under-mkeys2` corners).
 *
 * Every test below asserts the EXACT byte sequence the real xterm /
 * kitty references produce under the negotiated mode. A single-byte drift
 * fails visibly; the commentary on each case names the spec anchor.
 *
 * Scope is strictly `features/input/encoders/*`. The host-wiring checks
 * (IME suppression, guard, paste gate) live in neighboring files under
 * `__tests__/`.
 */
import { describe, expect, it } from 'vitest';

import { KeyEncoder } from '../KeyEncoder';
import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import { encodeKitty } from '../encoders/kitty';
import { encodeLegacy } from '../encoders/legacy';
import { encodeModifyOtherKeysV1 } from '../encoders/modify-other-keys-v1';
import { encodeModifyOtherKeysV2 } from '../encoders/modify-other-keys-v2';
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// §1.1 F13..F24 under legacy encoder — `input-matrix.json` only covers F1..F12
// ---------------------------------------------------------------------------
describe('audit §1.1 — F13..F24 tilde codes (legacy)', () => {
  const snap = mkSnap();
  const cases: Array<[string, number]> = [
    ['F13', 25],
    ['F14', 26],
    ['F15', 28],
    ['F16', 29],
    ['F17', 31],
    ['F18', 32],
    ['F19', 33],
    ['F20', 34],
    ['F21', 42],
    ['F22', 43],
    ['F23', 44],
    ['F24', 45],
  ];
  for (const [key, code] of cases) {
    it(`${key} → ESC [ ${code} ~ (legacy)`, () => {
      /**
       * Extended F-keys emit CSI <code> ~ per xterm ctlseqs. We anchor
       * the full byte sequence so no future refactor of `F_KEY_CODE`
       * silently drops F13+.
       */
      const out = encodeLegacy(mkEvent({ key, code: key }), snap);
      const digits = String(code)
        .split('')
        .map((d) => d.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
      expect(toHex(out)).toBe(`1b5b${digits}7e`);
    });
  }

  it('Ctrl+F13 → ESC [ 25 ; 5 ~', () => {
    /** Modified extended F-key — modifier param between code and tilde. */
    const out = encodeLegacy(
      mkEvent({ key: 'F13', code: 'F13', ctrlKey: true }),
      snap,
    );
    expect(toHex(out)).toBe('1b5b32353b357e');
  });
});

// ---------------------------------------------------------------------------
// §1.2 Shift+Tab (backtab) across modes
// ---------------------------------------------------------------------------
describe('audit §1.2 — Shift+Tab backtab across encoding modes', () => {
  it('legacy Shift+Tab → ESC [ Z (CBT)', () => {
    const out = encodeLegacy(mkEvent({ key: 'Tab', shiftKey: true }), mkSnap());
    expect(toHex(out)).toBe('1b5b5a');
  });

  it('mkeys=1 Shift+Tab stays on legacy ESC [ Z (Tab+Shift carved out per §3.3)', () => {
    /**
     * `shouldEmitCsi27` explicitly excludes Tab+Shift so Shift+Tab keeps
     * its unambiguous CSI Z backtab rather than morphing into
     * `CSI 27 ; 2 ; 9 ~`.
     */
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Tab', shiftKey: true }),
      mkSnap({ modifyOtherKeys: 1 }),
    );
    expect(toHex(out)).toBe('1b5b5a');
  });

  it('mkeys=2 Shift+Tab → ESC [ 27 ; 2 ; 9 ~ (named + mod path)', () => {
    /**
     * Under full modifyOtherKeys, ALL modified named keys take the
     * CSI-27 shape. This verifies the divergence from mkeys=1.
     */
    const out = encodeModifyOtherKeysV2(
      mkEvent({ key: 'Tab', shiftKey: true }),
      mkSnap({ modifyOtherKeys: 2 }),
    );
    expect(toHex(out)).toBe('1b5b32373b323b397e');
  });

  it('kitty L1 Shift+Tab → ESC [ 9 ; 2 u', () => {
    /**
     * Kitty keycode table maps Tab to 9; modifier bitmap adds 1 for
     * Shift (bit 0 set).
     */
    const out = encodeKitty(
      mkEvent({ key: 'Tab', shiftKey: true }),
      mkSnap({ kittyKeyboard: 1 }),
      1,
    );
    expect(toHex(out)).toBe('1b5b393b3275');
  });
});

// ---------------------------------------------------------------------------
// §1.3 Ctrl+Shift+letter under mkeys=2
// ---------------------------------------------------------------------------
describe('audit §1.3 — Ctrl+Shift+letter under mkeys=2 escalates', () => {
  /**
   * Under mkeys=2, Ctrl+A stays on the bare 0x01 byte for shell
   * compatibility. BUT Ctrl+Shift+A ships with BOTH Shift and Ctrl —
   * the `ctrlOnly` carve-out in `modify-other-keys-v2.ts` does NOT
   * apply, so the encoder MUST emit the CSI-27 form. This is the
   * distinction between "I want interrupt" (Ctrl+C → 0x03) and "I want
   * a keycode only the app recognizes" (Ctrl+Shift+C → ESC [ 27 ; 6 ; 67 ~).
   */
  const snap = mkSnap({ modifyOtherKeys: 2 });

  it('Ctrl+Shift+A (uppercase key) → ESC [ 27 ; 6 ; 65 ~', () => {
    // 'A' is a single-char printable with hasMod=true, non-ctrlOnly.
    const out = encodeModifyOtherKeysV2(
      mkEvent({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true }),
      snap,
    );
    // modifier = shift(1) + ctrl(4) + 1 = 6; keycode = 0x41 = 65
    expect(toHex(out)).toBe('1b5b32373b363b36357e');
  });

  it('Ctrl+Alt+A (no shift) → ESC [ 27 ; 7 ; 65 ~ (both non-ctrl-only mods)', () => {
    const out = encodeModifyOtherKeysV2(
      mkEvent({ key: 'A', code: 'KeyA', ctrlKey: true, altKey: true }),
      snap,
    );
    // modifier = alt(2) + ctrl(4) + 1 = 7; keycode = 65
    expect(toHex(out)).toBe('1b5b32373b373b36357e');
  });

  it('Ctrl+Shift+C shells around Ctrl+C — emits ESC [ 27 ; 6 ; 67 ~, NOT 0x03', () => {
    /**
     * CRITICAL: Ctrl+Shift+C must NOT collapse to the interrupt byte
     * under mkeys=2 — apps like vim/tmux rely on Ctrl+Shift+C being
     * distinguishable from Ctrl+C. This is the anti-regression pin.
     */
    const out = encodeModifyOtherKeysV2(
      mkEvent({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
      snap,
    );
    expect(toHex(out)).toBe('1b5b32373b363b36377e');
    // Sanity: the bare Ctrl+C path stays on 0x03.
    const interrupt = encodeModifyOtherKeysV2(
      mkEvent({ key: 'c', code: 'KeyC', ctrlKey: true }),
      snap,
    );
    expect(toHex(interrupt)).toBe('03');
  });
});

// ---------------------------------------------------------------------------
// §1.4 Kitty L2 keyup / repeat suffixes
// ---------------------------------------------------------------------------
describe('audit §1.4 — Kitty L2 event-kind suffixes (`;2` repeat, `;3` keyup)', () => {
  /**
   * Kitty level 2 adds the event-kind parameter after the modifier.
   * Repeat = 2, Release = 3. Level 1 MUST NOT emit these suffixes even
   * if `kind` or `repeat` are set on the event — that would produce
   * bogus bytes for L1 terminals.
   */
  const snap = mkSnap({ kittyKeyboard: 2 });

  it('Kitty L2 keydown with repeat=true → ESC [ 97 ; 1 ; 2 u', () => {
    const out = encodeKitty(
      mkEvent({ key: 'a', code: 'KeyA', repeat: true, kind: 'keydown' }),
      snap,
      2,
    );
    expect(toHex(out)).toBe('1b5b39373b313b3275');
  });

  it('Kitty L2 keyup → ESC [ 97 ; 1 ; 3 u', () => {
    const out = encodeKitty(
      mkEvent({ key: 'a', code: 'KeyA', kind: 'keyup' }),
      snap,
      2,
    );
    expect(toHex(out)).toBe('1b5b39373b313b3375');
  });

  it('Kitty L1 NEVER emits event-kind suffix even when repeat=true', () => {
    /**
     * Anti-regression: a Kitty L1 terminal would misparse a `;2` suffix.
     * The encoder must clamp suffix emission to level >= 2.
     */
    const out = encodeKitty(
      mkEvent({ key: 'a', code: 'KeyA', repeat: true, kind: 'keydown' }),
      mkSnap({ kittyKeyboard: 1 }),
      1,
    );
    expect(toHex(out)).toBe('1b5b39373b3175');
  });

  it('Kitty L2 keyup with Ctrl → ESC [ 97 ; 5 ; 3 u', () => {
    /** Modified + kind combinations should compose cleanly. */
    const out = encodeKitty(
      mkEvent({ key: 'a', code: 'KeyA', ctrlKey: true, kind: 'keyup' }),
      snap,
      2,
    );
    expect(toHex(out)).toBe('1b5b39373b353b3375');
  });
});

// ---------------------------------------------------------------------------
// §1.5 Kitty L3 alternate-layout codepoint
// ---------------------------------------------------------------------------
describe('audit §1.5 — Kitty L3 alt-layout codepoint (`:alt`)', () => {
  /**
   * When the user's physical `code` is `KeyA` but their layout produces
   * a different glyph (e.g. Dvorak `a` on QWERTY physical A), the
   * alternate-layout codepoint must appear after a colon. For a US-
   * layout key where `code` and `key` agree, no alt appears.
   */
  const snap = mkSnap({ kittyKeyboard: 3 });

  it('Kitty L3 `code=KeyA, key=a` has NO `:alt` (layout matches)', () => {
    const out = encodeKitty(
      mkEvent({ key: 'a', code: 'KeyA' }),
      snap,
      3,
    );
    expect(toHex(out)).toBe('1b5b39373b3175');
  });

  it('Kitty L3 `code=KeyA, key=q` emits ESC [ 113 : 97 ; 1 u (Dvorak on QWERTY)', () => {
    /**
     * physical key A — US glyph "a" (97) — current layout produced "q" (113).
     * Emission: <kc=113>:<alt=97>;<mod=1>u
     */
    const out = encodeKitty(
      mkEvent({ key: 'q', code: 'KeyA' }),
      snap,
      3,
    );
    expect(toHex(out)).toBe('1b5b3131333a39373b3175');
  });
});

// ---------------------------------------------------------------------------
// §1.6 Numpad digit keys
// ---------------------------------------------------------------------------
describe('audit §1.6 — Numpad keys emit their `key` glyph (not code-specific)', () => {
  /**
   * The browser reports a Numpad digit as `key='3'`, `code='Numpad3'`.
   * The encoder has no special-case for numpad digits under legacy — it
   * treats them as the printable digit. This pins that invariant so a
   * future "modifyOtherKeys=2 escalates numpad digits" change is noticed.
   */
  const snap = mkSnap();

  it('Numpad3 with no mods → 0x33 same as top-row Digit3', () => {
    const out = encodeLegacy(mkEvent({ key: '3', code: 'Numpad3' }), snap);
    expect(toHex(out)).toBe('33');
  });

  it('Ctrl+Numpad3 → empty (no CTRL_SYMBOL entry; digit dropped)', () => {
    /**
     * Legacy encoder's Ctrl+non-letter-non-symbol drops to 0 bytes.
     * Ctrl+3 in most real terminals also emits nothing (or the bell) —
     * so returning 0 bytes is the correct fall-through.
     */
    const out = encodeLegacy(
      mkEvent({ key: '3', code: 'Numpad3', ctrlKey: true }),
      snap,
    );
    expect(toHex(out)).toBe('');
  });

  it('NumpadAdd ("+") → 0x2b (printable)', () => {
    const out = encodeLegacy(mkEvent({ key: '+', code: 'NumpadAdd' }), snap);
    expect(toHex(out)).toBe('2b');
  });

  it('NumpadEnter key=Enter path still emits CR (0x0d)', () => {
    /**
     * The browser reports the numpad Enter as `key='Enter', code='NumpadEnter'`.
     * Encoder dispatches on `key`, so this must behave identically to the
     * main-keyboard Enter.
     */
    const out = encodeLegacy(
      mkEvent({ key: 'Enter', code: 'NumpadEnter' }),
      snap,
    );
    expect(toHex(out)).toBe('0d');
  });
});

// ---------------------------------------------------------------------------
// §1.7 Enter vs Ctrl+M (legacy collision) & Alt+Enter
// ---------------------------------------------------------------------------
describe('audit §1.7 — Enter/CR encoding invariants', () => {
  it('Enter and Ctrl+M collide on legacy (both 0x0d) — shell-expected', () => {
    /**
     * The ambiguity is exactly why `modifyOtherKeys=1` was invented;
     * under legacy it's intentional. Pinning this prevents a well-
     * meaning "make them distinct" regression.
     */
    const snap = mkSnap();
    expect(toHex(encodeLegacy(mkEvent({ key: 'Enter' }), snap))).toBe('0d');
    expect(
      toHex(encodeLegacy(mkEvent({ key: 'm', ctrlKey: true }), snap)),
    ).toBe('0d');
  });

  it('Alt+Enter emits ESC CR (fzf prefix form)', () => {
    /**
     * fzf treats Alt+Enter as "open in split" and depends on the ESC 0x0d
     * two-byte form. Kept out of the input matrix on the modifier-heavy
     * branches.
     */
    const snap = mkSnap();
    expect(
      toHex(encodeLegacy(mkEvent({ key: 'Enter', altKey: true }), snap)),
    ).toBe('1b0d');
  });
});

// ---------------------------------------------------------------------------
// §1.8 DECCKM toggle round-trip via KeyEncoder (live mirror flip)
// ---------------------------------------------------------------------------
describe('audit §1.8 — DECCKM toggle changes arrow encoding mid-session', () => {
  it('flip DECCKM on, arrows switch from CSI to SS3 immediately', () => {
    /**
     * End-to-end through `KeyEncoder` + `ModeSnapshot`: after the mirror
     * flips DECCKM, subsequent `encode()` calls must see the new mode.
     * This pins that the snapshot is NOT cached inside the encoder
     * across calls.
     */
    const mirror = createStubMirror({ decckm: false });
    const encoder = new KeyEncoder({ modeSnapshot: new ModeSnapshot(mirror) });
    const event: KeyEvent = mkEvent({ key: 'ArrowUp', code: 'ArrowUp' });

    const before = encoder.encode(event);
    expect(toHex(before.bytes)).toBe('1b5b41');

    mirror.applyMode({ decckm: true });
    const after = encoder.encode(event);
    expect(toHex(after.bytes)).toBe('1b4f41');
  });
});

// ---------------------------------------------------------------------------
// §1.9 Alt+Escape is NOT wrapped (current behavior is pinned)
// ---------------------------------------------------------------------------
describe('audit §1.9 — Alt+Escape encoding is a single ESC (not ESC ESC)', () => {
  /**
   * `legacy.ts` does NOT call `wrapAlt` on the Escape branch:
   *
   *   case 'Escape':
   *     return Uint8Array.of(0x1b);
   *
   * The xterm tradition is to emit ESC ESC (0x1b 0x1b) when meta-sends-
   * escape is active and the user presses Alt+Esc, but this project's
   * spec sheet (EPIC-E §3.2) treats Escape as terminal and does not
   * wrap. We pin that behavior here so a future refactor does not
   * silently introduce a double-ESC.
   *
   * This is intentionally a pinning test, NOT a bug assertion — the
   * spec is explicit that Escape is not alt-wrapped. If that decision
   * is revisited, this test becomes the TODO hook.
   */
  it('Alt+Escape → 0x1b (single ESC)', () => {
    const snap = mkSnap();
    const out = encodeLegacy(mkEvent({ key: 'Escape', altKey: true }), snap);
    expect(toHex(out)).toBe('1b');
  });
});

// ---------------------------------------------------------------------------
// §1.10 Kitty modifier-only key (Shift, Ctrl, …) emits 0 bytes
// ---------------------------------------------------------------------------
describe('audit §1.10 — Kitty modifier-only keys stay silent', () => {
  /**
   * Pressing just Shift (no accompanying character) should NOT emit any
   * bytes under Kitty — even though Shift would produce modifier bitmap
   * 2. This is the `isModifierOnly` gate in `kitty.ts`.
   */
  const snap = mkSnap({ kittyKeyboard: 2 });

  it('bare Shift press under Kitty L2 emits 0 bytes', () => {
    expect(
      toHex(encodeKitty(mkEvent({ key: 'Shift', shiftKey: true }), snap, 2)),
    ).toBe('');
  });

  it('bare Meta press under Kitty L3 emits 0 bytes', () => {
    expect(
      toHex(encodeKitty(mkEvent({ key: 'Meta', metaKey: true }), snap, 3)),
    ).toBe('');
  });
});
