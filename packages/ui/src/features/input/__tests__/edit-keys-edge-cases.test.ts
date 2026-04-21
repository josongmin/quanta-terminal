/**
 * Plan 0005 P0 audit follow-up — Backspace / Delete / Enter / Tab.
 *
 * The "edit keys" cluster is the densest compatibility minefield in
 * any terminal emulator: shells expect a very specific byte for each,
 * and reasonable people disagree on what that byte is (CR vs LF,
 * 0x7f vs 0x08, CSI 3 ~ vs CSI P, backtab via CSI Z).
 *
 * Quanta's documented choices (from `encoders/legacy.ts`):
 *   • Backspace           → 0x7f (DEL). Ctrl+Backspace → 0x08 (BS).
 *   • Delete              → ESC [ 3 ~ (CSI 3 ~, xterm-modern).
 *   • Enter               → 0x0d (CR). Alt+Enter → ESC + CR.
 *   • Tab (plain)         → 0x09.
 *   • Shift+Tab (backtab) → ESC [ Z (CSI Z).
 *
 * These are the SHELL-EXPECTED encodings — bash readline in default
 * mode, zsh with stock keymaps, and vi insert mode all round-trip on
 * the bytes listed above. Changing any one of them is a breaking
 * shell-compatibility change, so we pin the bytes here with explicit
 * commentary so a drift is impossible to merge silently.
 *
 * Agent R's keystroke edge file pins the backtab across modes (§1.2)
 * and Enter/Ctrl+M collision (§1.7). Do NOT duplicate those here.
 * This file focuses on:
 *   • Backspace across modifier combinations + encoding modes.
 *   • Delete (plain + modified + under kitty/mkeys).
 *   • Enter vs LF — proving no silent CR→LF conversion happens.
 *   • Tab under all encoding modes.
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

describe('audit §edit.1 — Backspace: plain vs Ctrl vs Alt', () => {
  it('plain Backspace → 0x7f (DEL, not 0x08)', () => {
    // Quanta matches every modern xterm / gnome-terminal / iTerm default:
    // the Backspace key sends DEL so readline can bind `\C-h` separately.
    const out = encodeLegacy(mkEvent({ key: 'Backspace' }), mkSnap());
    expect(toHex(out)).toBe('7f');
  });

  it('Ctrl+Backspace → 0x08 (BS) — disambiguates from Ctrl+H', () => {
    // Some shells (bash readline with `stty erase ^?`) treat Ctrl+BS
    // as "delete word backward" iff the byte is 0x08 distinct from the
    // plain Backspace 0x7f. Matching legacy.ts rationale comment.
    const out = encodeLegacy(
      mkEvent({ key: 'Backspace', ctrlKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('08');
  });

  it('Alt+Backspace → ESC + DEL (0x1b 0x7f) — bash readline "backward-kill-word"', () => {
    const out = encodeLegacy(
      mkEvent({ key: 'Backspace', altKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b7f');
  });

  it('Ctrl+Alt+Backspace → ESC + BS (0x1b 0x08)', () => {
    // Rarely used but well-defined: Ctrl wins the BS/DEL choice, Alt
    // adds the ESC prefix. No shell uses this bindings by default but
    // we want it deterministic.
    const out = encodeLegacy(
      mkEvent({ key: 'Backspace', ctrlKey: true, altKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b08');
  });

  it('modifyOtherKeys=1: Ctrl+Backspace → CSI 27 ; 5 ; 127 ~ (ambiguous promotion)', () => {
    // Under mkeys-1 the "ambiguous four" (Tab/Enter/Esc/Backspace) are
    // promoted to CSI-27 under ANY modifier, so xterm apps can see the
    // real keystroke independent of the legacy byte collision.
    // Keycode = 127 (the DEL shape per encoders/modify-other-keys-v1.ts).
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Backspace', ctrlKey: true }),
      mkSnap({ modifyOtherKeys: 1 }),
    );
    expect(toHex(out)).toBe('1b5b32373b353b3132377e');
  });

  it('kitty L1: Backspace → ESC [ 127 ; 1 u', () => {
    // kitty's keycode table maps Backspace → 127 (same as DEL). Plain
    // unmodified form.
    const out = encodeKitty(
      mkEvent({ key: 'Backspace' }),
      mkSnap({ kittyKeyboard: 1 }),
      1,
    );
    expect(toHex(out)).toBe('1b5b3132373b3175');
  });
});

describe('audit §edit.2 — Delete: CSI 3 ~ form (not CSI P)', () => {
  it('plain Delete → ESC [ 3 ~', () => {
    // xterm ctlseqs: Delete is CSI 3 ~ (the "modern" vt220 form). Some
    // ancient terminals used CSI P (DCH-1), which would be a grid
    // DELETE of the character under cursor — wrong shape for input.
    const out = encodeLegacy(mkEvent({ key: 'Delete' }), mkSnap());
    expect(toHex(out)).toBe('1b5b337e');
  });

  it('Shift+Delete → ESC [ 3 ; 2 ~ (modifier param between code and tilde)', () => {
    // Modified form uses the <code>;<mod>~ shape. Anchor both the
    // modifier position and the semicolon.
    const out = encodeLegacy(
      mkEvent({ key: 'Delete', shiftKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b5b333b327e');
  });

  it('Ctrl+Shift+Alt+Delete → ESC [ 3 ; 8 ~', () => {
    // 1|2|4+1 = 8, the triple-mod case.
    const out = encodeLegacy(
      mkEvent({ key: 'Delete', ctrlKey: true, shiftKey: true, altKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b5b333b387e');
  });
});

describe('audit §edit.3 — Enter / Tab: byte identity', () => {
  it('Enter (no mods) → 0x0d (CR) — NOT 0x0a (LF)', () => {
    // Almost every shell expects CR on Enter; the TTY driver does the
    // CR→LF translation (onlcr) for OUTPUT only, not input. Emitting
    // LF here would break bash/zsh line-editing keymaps that bind to
    // `C-m` (which IS CR). Byte anchor is load-bearing.
    const out = encodeLegacy(mkEvent({ key: 'Enter' }), mkSnap());
    expect(toHex(out)).toBe('0d');
  });

  it('plain Tab → 0x09 (HT)', () => {
    const out = encodeLegacy(mkEvent({ key: 'Tab' }), mkSnap());
    expect(toHex(out)).toBe('09');
  });

  it('Shift+Tab (legacy) → ESC [ Z (CBT)', () => {
    // Backtab: the VT220 "cursor back tab" sequence. Shells use it in
    // completion menus (fzf, zsh's complete-list).
    const out = encodeLegacy(
      mkEvent({ key: 'Tab', shiftKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b5b5a');
  });

  it('Alt+Tab emits ESC + HT (0x1b 0x09) — rarely intercepted by OS', () => {
    // Note: most OSes capture Alt+Tab for window switching long before
    // it reaches the browser. When the OS passes it through (rare),
    // the encoder emits ESC + HT faithfully. Anchoring the encoder
    // contract here lets tests run independently of OS behavior.
    const out = encodeLegacy(
      mkEvent({ key: 'Tab', altKey: true }),
      mkSnap(),
    );
    expect(toHex(out)).toBe('1b09');
  });
});

describe('audit §edit.4 — Enter / Tab under modifyOtherKeys=2', () => {
  it('unmodified Enter under mkeys=2 stays 0x0d (no CSI-27)', () => {
    // §3.3: unmodified named keys keep their legacy byte even under
    // mkeys-2. Breakage here would kill interactive shells.
    const out = encodeModifyOtherKeysV2(
      mkEvent({ key: 'Enter' }),
      mkSnap({ modifyOtherKeys: 2 }),
    );
    expect(toHex(out)).toBe('0d');
  });

  it('Ctrl+Enter under mkeys=2 → ESC [ 27 ; 5 ; 13 ~', () => {
    // Modified Enter under mkeys-2 MUST promote — otherwise the shell
    // cannot distinguish Ctrl+Enter from plain Enter (both 0x0d bare).
    const out = encodeModifyOtherKeysV2(
      mkEvent({ key: 'Enter', ctrlKey: true }),
      mkSnap({ modifyOtherKeys: 2 }),
    );
    expect(toHex(out)).toBe('1b5b32373b353b31337e');
  });

  it('Ctrl+Tab under mkeys=2 → ESC [ 27 ; 5 ; 9 ~', () => {
    const out = encodeModifyOtherKeysV2(
      mkEvent({ key: 'Tab', ctrlKey: true }),
      mkSnap({ modifyOtherKeys: 2 }),
    );
    expect(toHex(out)).toBe('1b5b32373b353b397e');
  });
});

describe('audit §edit.5 — kitty L1 Delete / Enter / Tab', () => {
  it('Delete kitty-1 → ESC [ 57349 ; 1 u', () => {
    // kitty named-key keycode for Delete is 57349.
    const out = encodeKitty(
      mkEvent({ key: 'Delete' }),
      mkSnap({ kittyKeyboard: 1 }),
      1,
    );
    expect(toHex(out)).toBe('1b5b35373334393b3175');
  });

  it('Enter kitty-1 → ESC [ 13 ; 1 u', () => {
    // kitty keeps the ASCII 0x0d codepoint as the keycode.
    const out = encodeKitty(
      mkEvent({ key: 'Enter' }),
      mkSnap({ kittyKeyboard: 1 }),
      1,
    );
    expect(toHex(out)).toBe('1b5b31333b3175');
  });

  it('Tab kitty-1 → ESC [ 9 ; 1 u', () => {
    const out = encodeKitty(
      mkEvent({ key: 'Tab' }),
      mkSnap({ kittyKeyboard: 1 }),
      1,
    );
    expect(toHex(out)).toBe('1b5b393b3175');
  });
});
