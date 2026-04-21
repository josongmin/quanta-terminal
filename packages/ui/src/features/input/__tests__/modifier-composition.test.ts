/**
 * Plan 0005 P0 audit follow-up — modifier composition edge cases.
 *
 * The encoder receives raw DOM modifier bits (`ctrlKey`, `altKey`,
 * `metaKey`, `shiftKey`) without platform translation. The UI layer
 * (SessionInputSurface, defaultKeymapGuard) is the piece that decides
 * whether "mod" means Cmd on macOS or Ctrl elsewhere. The encoder
 * itself honors every flag verbatim per xterm's bitmap convention.
 *
 * These tests pin the corner cases that surface when a real keyboard
 * generates combinations the happy-path matrix does NOT cover:
 *
 *   §mod.1  Both metaKey AND ctrlKey set (user holds Cmd+Ctrl+K) —
 *           encoder passes both bits through untouched.
 *   §mod.2  AltGraph / ISO_Level3_Shift on EU keyboards —
 *           browsers report `altKey=true` AND emit the composed glyph
 *           via `event.key`. Encoder must emit the glyph WITHOUT an
 *           ESC prefix (AltGr is a layout-level composer, not an Alt
 *           modifier) — or, per the spec defined here, emit the
 *           printable and document the conservative choice.
 *   §mod.3  Numeric keypad digits with NumLock — `event.key` is the
 *           digit (NumLock on) or the navigation label ("Home", etc.)
 *           (NumLock off). Encoder honors `key` verbatim.
 *   §mod.4  xterm modifier bitmap arithmetic — Shift=1, Alt=2,
 *           Ctrl=4, +1 base. Meta has NO bit in the xterm map.
 *   §mod.5  Kitty modifier bitmap — Shift=1, Alt=2, Ctrl=4, Meta=8
 *           (Super), +1 base. Meta IS represented in kitty.
 */
import { describe, expect, it } from 'vitest';

import { encodeKitty } from '../encoders/kitty';
import { encodeLegacy } from '../encoders/legacy';
import { kittyModifier, xtermModifier } from '../encoders/shared';
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

describe('audit §mod.1 — Cmd+Ctrl held simultaneously', () => {
  it('legacy: metaKey=true + ctrlKey=true + key="c" emits the Ctrl byte (0x03)', () => {
    // On a Mac the user sometimes holds Cmd+Ctrl+C while switching
    // between browser-level zoom and shell SIGINT. The encoder has no
    // concept of "mod" — it sees ctrlKey=true and emits the control
    // byte. Meta is ignored (xterm bitmap has no Meta bit).
    const out = encodeLegacy(
      mkEvent({ key: 'c', code: 'KeyC', ctrlKey: true, metaKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('03');
  });

  it('kitty L1: metaKey+ctrlKey both ride the modifier bitmap (bits 4|8+1 = 13)', () => {
    // Kitty DOES carry Meta as the Super bit. Cmd+Ctrl+a under kitty
    // produces modifier = (ctrl|meta)+1 = 4+8+1 = 13, keycode 97.
    const out = encodeKitty(
      mkEvent({ key: 'a', code: 'KeyA', ctrlKey: true, metaKey: true }),
      mkSnap({ kittyKeyboard: 1 }),
      1,
    );
    expect(toHex(out)).toBe('1b5b39373b313375'); // ESC [ 97 ; 13 u
  });

  it('xtermModifier helper: ctrl+meta returns 5 (meta dropped)', () => {
    expect(xtermModifier(mkEvent({ key: 'a', ctrlKey: true, metaKey: true }))).toBe(5);
  });

  it('kittyModifier helper: ctrl+meta returns 13 (meta preserved)', () => {
    expect(kittyModifier(mkEvent({ key: 'a', ctrlKey: true, metaKey: true }))).toBe(13);
  });
});

describe('audit §mod.2 — AltGr / ISO_Level3_Shift on European keyboards', () => {
  it('legacy: altKey=true + key="@" (AltGr+2 on DE layout) emits ESC prefix ("alt-@")', () => {
    // Known compromise: the DOM reports AltGr as `altKey=true`, same as
    // a real Alt press. The encoder cannot distinguish them without
    // `getModifierState('AltGraph')`, which is not on the KeyEvent
    // interface. So AltGr+2="@" on DE layout emits ESC "@" (0x1b 0x40)
    // — identical to Alt+@. This is the conservative current behavior;
    // the TODO is to consume `getModifierState` via input-host and pass
    // a dedicated `altGraph` flag to the encoder.
    //
    // TODO(EPIC-E §altgr): thread `altGraph: boolean` through KeyEvent
    // and suppress the ESC prefix when it's true, so DE/FR/ES users get
    // their composed glyph cleanly.
    const out = encodeLegacy(
      mkEvent({ key: '@', code: 'Digit2', altKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b40'); // ESC '@'
  });

  it('legacy: composed glyph "€" with altKey=true still emits ESC + UTF-8 payload', () => {
    // Same rationale — AltGr+E on DE produces €; encoder treats it as
    // Alt+€ and prefixes ESC. User-visible behavior is identical to
    // Alt+€ (unusable in the shell unless the shell's own readline
    // decodes Alt-prefixed chars). Flagged so when the fix lands we
    // change expectations here.
    const out = encodeLegacy(
      mkEvent({ key: '€', code: 'KeyE', altKey: true }),
      mkSnap(),
    );
    // UTF-8 of '€' is e2 82 ac (three bytes), preceded by 0x1b.
    expect(toHex(out)).toBe('1be282ac');
  });

  it('legacy: AltGraph as the KEY (rarely fired) emits 0 bytes', () => {
    // `event.key === 'AltGraph'` is the modifier-only press. `isModifierName`
    // in the legacy encoder filters this so the downstream shell never
    // sees a stray ESC.
    const out = encodeLegacy(
      mkEvent({ key: 'AltGraph', code: 'AltRight' }),
      mkSnap(),
    );
    expect(out.length).toBe(0);
  });
});

describe('audit §mod.3 — Numeric keypad with / without NumLock', () => {
  it('NumLock ON: Numpad7 with key="7" emits 0x37 (plain digit)', () => {
    // Browsers report `key: "7"` / `code: "Numpad7"` when NumLock is on.
    // The encoder trusts `key` and emits the digit.
    const out = encodeLegacy(
      mkEvent({ key: '7', code: 'Numpad7' }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('37');
  });

  it('NumLock OFF: Numpad7 with key="Home" emits ESC [ H (Home sequence)', () => {
    // NumLock off flips `key` to the navigation label. The encoder
    // treats this as a proper Home press → CSI H. DECCKM off, unmodified.
    const out = encodeLegacy(
      mkEvent({ key: 'Home', code: 'Numpad7' }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b5b48'); // ESC [ H
  });

  it('NumLock OFF + DECCKM ON: Numpad7 → key="Home" emits SS3 H', () => {
    // DECCKM flips the introducer; the encoder still reaches the
    // endpoint branch via `key === "Home"`.
    const out = encodeLegacy(
      mkEvent({ key: 'Home', code: 'Numpad7' }),
      mkSnap({ decckm: true }),
    );
    expect(toHex(out)).toBe('1b4f48'); // ESC O H
  });

  it('NumLock state is NOT encoded on the wire — `NumLock` key press is a no-op', () => {
    // Toggling NumLock itself emits no bytes (modifier-only filter).
    // The state change is visible only through subsequent key events.
    const out = encodeLegacy(
      mkEvent({ key: 'NumLock', code: 'NumLock' }),
      mkSnap(),
    );
    expect(out.length).toBe(0);
  });
});

describe('audit §mod.4 — xterm modifier bitmap arithmetic regressions', () => {
  it('no mods = 1; shift = 2; alt = 3; shift+alt = 4; ctrl = 5; ctrl+shift = 6; ctrl+alt = 7; ctrl+shift+alt = 8', () => {
    expect(xtermModifier(mkEvent({ key: 'a' }))).toBe(1);
    expect(xtermModifier(mkEvent({ key: 'a', shiftKey: true }))).toBe(2);
    expect(xtermModifier(mkEvent({ key: 'a', altKey: true }))).toBe(3);
    expect(xtermModifier(mkEvent({ key: 'a', shiftKey: true, altKey: true }))).toBe(4);
    expect(xtermModifier(mkEvent({ key: 'a', ctrlKey: true }))).toBe(5);
    expect(xtermModifier(mkEvent({ key: 'a', ctrlKey: true, shiftKey: true }))).toBe(6);
    expect(xtermModifier(mkEvent({ key: 'a', ctrlKey: true, altKey: true }))).toBe(7);
    expect(
      xtermModifier(mkEvent({ key: 'a', ctrlKey: true, shiftKey: true, altKey: true })),
    ).toBe(8);
  });

  it('xterm never ORs in Meta (macOS Cmd is invisible to the modifier param)', () => {
    // metaKey=true alone should NOT change the xterm modifier — unlike
    // kitty. Proves we don't accidentally regress to a "mod+1" shape on
    // a Mac.
    expect(xtermModifier(mkEvent({ key: 'a', metaKey: true }))).toBe(1);
    expect(xtermModifier(mkEvent({ key: 'a', metaKey: true, shiftKey: true }))).toBe(2);
  });
});

describe('audit §mod.5 — kitty modifier bitmap arithmetic', () => {
  it('kitty preserves meta as Super bit (bit 8); ordinary no-mod = 1', () => {
    expect(kittyModifier(mkEvent({ key: 'a' }))).toBe(1);
    expect(kittyModifier(mkEvent({ key: 'a', metaKey: true }))).toBe(9);
    expect(kittyModifier(mkEvent({ key: 'a', shiftKey: true, metaKey: true }))).toBe(10);
    expect(
      kittyModifier(
        mkEvent({ key: 'a', ctrlKey: true, shiftKey: true, altKey: true, metaKey: true }),
      ),
    ).toBe(16); // 1|2|4|8 = 15, +1 = 16
  });
});
