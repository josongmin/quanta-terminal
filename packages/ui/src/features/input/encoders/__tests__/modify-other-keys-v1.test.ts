/**
 * Unit tests for `encodeModifyOtherKeysV1` — xterm `CSI > 4 ; 1 m`
 * (partial mode).
 *
 * Covers the gap matrix promised in EPIC-E §3.3:
 *
 *   - Ambiguous named keys (Tab / Enter / Escape / Backspace) under any
 *     modifier → `CSI 27 ; <mod> ; <code> ~`.
 *   - Unambiguous legacy keys (Ctrl+letter, plain printables, bare Tab) →
 *     still emit the legacy byte.
 *   - `modifyOtherKeys=0` vs `=1` vs `=2` diff matrix for the shared key set.
 */
import { describe, expect, it } from 'vitest';

import { KeyEncoder } from '../../KeyEncoder';
import { createStubMirror, ModeSnapshot } from '../../ModeSnapshot';
import type { KeyEvent, TerminalModeSnapshot } from '../../types';
import { encodeModifyOtherKeysV1 } from '../modify-other-keys-v1';

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

function mkSnapshot(
  partial: Partial<Omit<TerminalModeSnapshot, 'snapshotEpoch'>> = {},
): TerminalModeSnapshot {
  return Object.freeze({
    decckm: false,
    bracketedPaste: false,
    focusReporting: false,
    mouseTracking: 'off' as const,
    mouseEncoding: 'default' as const,
    modifyOtherKeys: 1 as const,
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

describe('encodeModifyOtherKeysV1 — ambiguous keys emit CSI 27', () => {
  const snap = mkSnapshot();

  it('Ctrl+Tab → ESC [ 27 ; 5 ; 9 ~', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Tab', code: 'Tab', ctrlKey: true }),
      snap,
    );
    // 1b 5b 32 37 3b 35 3b 39 7e  ==  ESC [ 2 7 ; 5 ; 9 ~
    expect(toHex(out)).toBe('1b5b32373b353b397e');
  });

  it('Ctrl+Enter (aka Ctrl+M) → ESC [ 27 ; 5 ; 13 ~', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Enter', code: 'Enter', ctrlKey: true }),
      snap,
    );
    // 1b 5b 32 37 3b 35 3b 31 33 7e  ==  ESC [ 2 7 ; 5 ; 1 3 ~
    expect(toHex(out)).toBe('1b5b32373b353b31337e');
  });

  it('Ctrl+Escape → ESC [ 27 ; 5 ; 27 ~', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Escape', code: 'Escape', ctrlKey: true }),
      snap,
    );
    expect(toHex(out)).toBe('1b5b32373b353b32377e');
  });

  it('Alt+Backspace → ESC [ 27 ; 3 ; 127 ~', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Backspace', code: 'Backspace', altKey: true }),
      snap,
    );
    // modifier 3 = Alt; keycode 127
    expect(toHex(out)).toBe('1b5b32373b333b3132377e');
  });

  it('Shift+Enter → ESC [ 27 ; 2 ; 13 ~ (shift alone still disambiguates)', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Enter', code: 'Enter', shiftKey: true }),
      snap,
    );
    // modifier 2 = Shift; keycode 13
    expect(toHex(out)).toBe('1b5b32373b323b31337e');
  });

  it('Ctrl+Shift+Tab → CSI 27 ; 6 ; 9 ~ (combined modifier bits)', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }),
      snap,
    );
    // modifier = shift(1) + ctrl(4) + 1 offset = 6
    expect(toHex(out)).toBe('1b5b32373b363b397e');
  });
});

describe('encodeModifyOtherKeysV1 — unambiguous keys stay on legacy', () => {
  const snap = mkSnapshot();

  it('Ctrl+A → 0x01 (legacy control byte)', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'a', code: 'KeyA', ctrlKey: true }),
      snap,
    );
    expect(toHex(out)).toBe('01');
  });

  it('bare Tab → 0x09', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Tab', code: 'Tab' }),
      snap,
    );
    expect(toHex(out)).toBe('09');
  });

  it('bare Enter → 0x0d', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Enter', code: 'Enter' }),
      snap,
    );
    expect(toHex(out)).toBe('0d');
  });

  it('Shift+Tab → ESC [ Z (legacy owns Shift+Tab)', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'Tab', code: 'Tab', shiftKey: true }),
      snap,
    );
    expect(toHex(out)).toBe('1b5b5a');
  });

  it('plain letter → UTF-8 byte', () => {
    const out = encodeModifyOtherKeysV1(mkEvent({ key: 'a', code: 'KeyA' }), snap);
    expect(toHex(out)).toBe('61');
  });

  it('Alt+a → ESC + a (legacy meta prefix)', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'a', code: 'KeyA', altKey: true }),
      snap,
    );
    expect(toHex(out)).toBe('1b61');
  });

  it('Ctrl+Shift+A under mkeys=1 stays on legacy 0x01 (mkeys=2-only shape)', () => {
    const out = encodeModifyOtherKeysV1(
      mkEvent({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true }),
      snap,
    );
    expect(toHex(out)).toBe('01');
  });
});

describe('KeyEncoder — modifyOtherKeys 0/1/2 diff matrix', () => {
  function encodeAt(mkeys: 0 | 1 | 2, event: KeyEvent): string {
    const mirror = createStubMirror({ modifyOtherKeys: mkeys });
    const encoder = new KeyEncoder({ modeSnapshot: new ModeSnapshot(mirror) });
    const out = encoder.encode(event);
    return toHex(out.bytes);
  }

  it('Ctrl+Tab differs across all three mkeys modes', () => {
    const ev = mkEvent({ key: 'Tab', code: 'Tab', ctrlKey: true });
    // mkeys=0: legacy — collapses with Ctrl+I → 0x09
    expect(encodeAt(0, ev)).toBe('09');
    // mkeys=1: ambiguous → CSI 27;5;9~
    expect(encodeAt(1, ev)).toBe('1b5b32373b353b397e');
    // mkeys=2: also CSI 27;5;9~ — named keys with modifiers share the shape
    expect(encodeAt(2, ev)).toBe('1b5b32373b353b397e');
  });

  it('Ctrl+A: mkeys=0/1 legacy 0x01, mkeys=2 also 0x01 (letter + ctrl-only special-case)', () => {
    const ev = mkEvent({ key: 'a', code: 'KeyA', ctrlKey: true });
    expect(encodeAt(0, ev)).toBe('01');
    expect(encodeAt(1, ev)).toBe('01');
    // mkeys=2 keeps Ctrl+letter on bare byte for shell compatibility (§3.3).
    expect(encodeAt(2, ev)).toBe('01');
  });

  it('Alt+a: mkeys=0/1 stay on ESC+a, mkeys=2 escalates to CSI 27', () => {
    const ev = mkEvent({ key: 'a', code: 'KeyA', altKey: true });
    expect(encodeAt(0, ev)).toBe('1b61');
    expect(encodeAt(1, ev)).toBe('1b61');
    // mkeys=2: ESC [ 27;3;97 ~
    expect(encodeAt(2, ev)).toBe('1b5b32373b333b39377e');
  });

  it('mkeys=0 emits legacy for ALL the ambiguous keys', () => {
    const specs: Array<[KeyEvent, string]> = [
      [mkEvent({ key: 'Tab', code: 'Tab', ctrlKey: true }), '09'],
      [mkEvent({ key: 'Enter', code: 'Enter', ctrlKey: true }), '0d'],
      [mkEvent({ key: 'Escape', code: 'Escape', ctrlKey: true }), '1b'],
      // Ctrl+Backspace maps to 0x08 in legacy (§3.2 disambiguation).
      [mkEvent({ key: 'Backspace', code: 'Backspace', ctrlKey: true }), '08'],
    ];
    for (const [ev, hex] of specs) {
      expect(encodeAt(0, ev)).toBe(hex);
    }
  });

  it('IME composing suppresses output in mkeys=1', () => {
    const mirror = createStubMirror({ modifyOtherKeys: 1 });
    const encoder = new KeyEncoder({ modeSnapshot: new ModeSnapshot(mirror) });
    const out = encoder.encode(
      mkEvent({ key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true }),
    );
    expect(out.bytes.length).toBe(0);
    expect(out.diagnostics.suppressedForComposition).toBe(true);
  });
});
