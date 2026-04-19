/**
 * Unit tests for the legacy xterm key encoder (`encoders/legacy.ts`).
 *
 * These tests isolate `encodeLegacy` — the pure, DECCKM-aware byte
 * emitter — from the surrounding `KeyEncoder` plumbing. We verify byte
 * output exactly, using hex array comparisons so a one-byte drift fails
 * visibly.
 *
 * References:
 *   - RFC 0001 §22 (keyboard envelope)
 *   - xterm ctlseqs (modifiers, DECCKM)
 *   - `features/input/encoders/legacy.ts`
 */
import { describe, expect, it } from 'vitest';

import { encodeLegacy } from '../legacy';
import type { KeyEvent, TerminalModeSnapshot } from '../../types';

const ESC = 0x1b;
const CSI_PREFIX = [ESC, 0x5b]; // ESC [
const SS3_PREFIX = [ESC, 0x4f]; // ESC O

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

function mkSnapshot(partial: Partial<Omit<TerminalModeSnapshot, 'snapshotEpoch'>> = {}): TerminalModeSnapshot {
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

function bytes(encoded: Uint8Array): number[] {
  return Array.from(encoded);
}

const OFF = mkSnapshot({ decckm: false });
const ON = mkSnapshot({ decckm: true });

describe('encodeLegacy — ASCII printable', () => {
  it("plain lowercase 'a' → 0x61", () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'a' }), OFF))).toEqual([0x61]);
  });

  it("shifted 'A' → 0x41 (shiftKey is advisory; key already uppercase)", () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'A', shiftKey: true }), OFF))).toEqual([0x41]);
  });

  it("digit '7' → 0x37", () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '7' }), OFF))).toEqual([0x37]);
  });

  it("punctuation '!' → 0x21", () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '!', shiftKey: true }), OFF))).toEqual([0x21]);
  });

  it('multibyte unicode key emits UTF-8 bytes (한 → E1 95 9C)', () => {
    // '한' = U+D55C → UTF-8: 0xED 0x95 0x9C
    expect(bytes(encodeLegacy(mkEvent({ key: '한' }), OFF))).toEqual([0xed, 0x95, 0x9c]);
  });
});

describe('encodeLegacy — Ctrl+letter matrix (C0 control bytes)', () => {
  const rows: Array<[string, number]> = [
    ['a', 0x01],
    ['b', 0x02],
    ['c', 0x03],
    ['d', 0x04],
    ['i', 0x09], // Note: collides with Tab byte but Ctrl+I path differs
    ['m', 0x0d], // collides with CR
    ['z', 0x1a],
    ['A', 0x01], // case-insensitive
    ['Z', 0x1a],
  ];
  for (const [letter, expected] of rows) {
    it(`Ctrl+${letter} → 0x${expected.toString(16).padStart(2, '0')}`, () => {
      expect(bytes(encodeLegacy(mkEvent({ key: letter, ctrlKey: true }), OFF))).toEqual([expected]);
    });
  }

  it('Ctrl+@ → 0x00 (NUL via CTRL_SYMBOL)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '@', ctrlKey: true }), OFF))).toEqual([0x00]);
  });

  it('Ctrl+[ → 0x1b (ESC)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '[', ctrlKey: true }), OFF))).toEqual([0x1b]);
  });

  it('Ctrl+\\ → 0x1c (FS)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '\\', ctrlKey: true }), OFF))).toEqual([0x1c]);
  });

  it('Ctrl+] → 0x1d (GS)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: ']', ctrlKey: true }), OFF))).toEqual([0x1d]);
  });

  it('Ctrl+^ → 0x1e (RS)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '^', ctrlKey: true }), OFF))).toEqual([0x1e]);
  });

  it('Ctrl+_ → 0x1f (US)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '_', ctrlKey: true }), OFF))).toEqual([0x1f]);
  });

  it('Ctrl+Space → 0x00 (NUL)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: ' ', ctrlKey: true }), OFF))).toEqual([0x00]);
  });

  it('Ctrl+/ → 0x1f', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '/', ctrlKey: true }), OFF))).toEqual([0x1f]);
  });

  it('Ctrl+? → 0x7f (DEL)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '?', ctrlKey: true }), OFF))).toEqual([0x7f]);
  });

  it('Ctrl+Shift+A → 0x01 (no kitty uppercase path in legacy — same as Ctrl+A; RFC §22 #2)', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'A', ctrlKey: true, shiftKey: true }), OFF)),
    ).toEqual([0x01]);
  });
});

describe('encodeLegacy — Alt/Meta wrap (ESC prefix)', () => {
  it('Alt+a → ESC 0x61', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'a', altKey: true }), OFF))).toEqual([ESC, 0x61]);
  });

  it('Alt+Enter → ESC CR (RFC §22 #3 fzf)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Enter', altKey: true }), OFF))).toEqual([ESC, 0x0d]);
  });

  it('Ctrl+Alt+b (tmux prefix style) → ESC 0x02 (RFC §22 #4)', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'b', ctrlKey: true, altKey: true }), OFF)),
    ).toEqual([ESC, 0x02]);
  });

  it('Alt+Backspace → ESC 0x7F', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'Backspace', altKey: true }), OFF)),
    ).toEqual([ESC, 0x7f]);
  });

  it('Alt+Space → ESC 0x20', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: ' ', altKey: true }), OFF))).toEqual([ESC, 0x20]);
  });
});

describe('encodeLegacy — named single-byte keys', () => {
  it('Enter → CR (0x0d)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Enter' }), OFF))).toEqual([0x0d]);
  });

  it('Tab → 0x09', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Tab' }), OFF))).toEqual([0x09]);
  });

  it('Shift+Tab → ESC [ Z (CBT)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Tab', shiftKey: true }), OFF))).toEqual([
      ...CSI_PREFIX,
      0x5a,
    ]);
  });

  it('Backspace → 0x7F (DEL per §3.2 decision)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Backspace' }), OFF))).toEqual([0x7f]);
  });

  it('Ctrl+Backspace → 0x08 (BS, disambiguates from Ctrl+H)', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'Backspace', ctrlKey: true }), OFF)),
    ).toEqual([0x08]);
  });

  it('Escape → 0x1B', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Escape' }), OFF))).toEqual([0x1b]);
  });

  it('Space → 0x20', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: ' ' }), OFF))).toEqual([0x20]);
  });
});

describe('encodeLegacy — F1..F4 (SS3 sequence)', () => {
  const rows: Array<[string, number]> = [
    ['F1', 0x50],
    ['F2', 0x51],
    ['F3', 0x52],
    ['F4', 0x53],
  ];
  for (const [key, final] of rows) {
    it(`${key} → ESC O <${String.fromCharCode(final)}>`, () => {
      expect(bytes(encodeLegacy(mkEvent({ key }), OFF))).toEqual([...SS3_PREFIX, final]);
    });
  }

  it('Shift+F1 → ESC O 1 ; 2 P', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'F1', shiftKey: true }), OFF))).toEqual([
      ...SS3_PREFIX,
      0x31,
      0x3b,
      0x32,
      0x50,
    ]);
  });

  it('Ctrl+F4 → ESC O 1 ; 5 S', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'F4', ctrlKey: true }), OFF))).toEqual([
      ...SS3_PREFIX,
      0x31,
      0x3b,
      0x35,
      0x53,
    ]);
  });
});

describe('encodeLegacy — F5..F24 (CSI ~ sequence)', () => {
  const rows: Array<[string, number]> = [
    ['F5', 15],
    ['F6', 17],
    ['F7', 18],
    ['F8', 19],
    ['F9', 20],
    ['F10', 21],
    ['F11', 23],
    ['F12', 24],
    ['F13', 25],
    ['F24', 45],
  ];
  for (const [key, code] of rows) {
    it(`${key} → ESC [ ${code} ~`, () => {
      const digits = String(code).split('').map((d) => d.charCodeAt(0));
      expect(bytes(encodeLegacy(mkEvent({ key }), OFF))).toEqual([
        ...CSI_PREFIX,
        ...digits,
        0x7e,
      ]);
    });
  }

  it('Alt+F5 → ESC [ 15 ; 3 ~', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'F5', altKey: true }), OFF))).toEqual([
      ...CSI_PREFIX,
      0x31,
      0x35,
      0x3b,
      0x33,
      0x7e,
    ]);
  });
});

describe('encodeLegacy — arrow keys (DECCKM)', () => {
  const rows: Array<[string, number]> = [
    ['ArrowUp', 0x41],
    ['ArrowDown', 0x42],
    ['ArrowRight', 0x43],
    ['ArrowLeft', 0x44],
  ];

  for (const [key, final] of rows) {
    it(`${key} with DECCKM off → ESC [ ${String.fromCharCode(final)}`, () => {
      expect(bytes(encodeLegacy(mkEvent({ key }), OFF))).toEqual([...CSI_PREFIX, final]);
    });

    it(`${key} with DECCKM on → ESC O ${String.fromCharCode(final)}`, () => {
      expect(bytes(encodeLegacy(mkEvent({ key }), ON))).toEqual([...SS3_PREFIX, final]);
    });
  }

  it('Shift+ArrowUp (DECCKM off) → ESC [ 1 ; 2 A (modifier overrides DECCKM)', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'ArrowUp', shiftKey: true }), OFF)),
    ).toEqual([...CSI_PREFIX, 0x31, 0x3b, 0x32, 0x41]);
  });

  it('Ctrl+ArrowRight → ESC [ 1 ; 5 C', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'ArrowRight', ctrlKey: true }), OFF)),
    ).toEqual([...CSI_PREFIX, 0x31, 0x3b, 0x35, 0x43]);
  });

  it('Ctrl+Shift+ArrowLeft → ESC [ 1 ; 6 D', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'ArrowLeft', ctrlKey: true, shiftKey: true }), OFF)),
    ).toEqual([...CSI_PREFIX, 0x31, 0x3b, 0x36, 0x44]);
  });

  it('Alt+ArrowUp (DECCKM on) still uses CSI form with modifier (not SS3)', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'ArrowUp', altKey: true }), ON))).toEqual([
      ...CSI_PREFIX,
      0x31,
      0x3b,
      0x33,
      0x41,
    ]);
  });
});

describe('encodeLegacy — Home/End (DECCKM-aware)', () => {
  it('Home (DECCKM off) → ESC [ H', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Home' }), OFF))).toEqual([...CSI_PREFIX, 0x48]);
  });

  it('End (DECCKM off) → ESC [ F', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'End' }), OFF))).toEqual([...CSI_PREFIX, 0x46]);
  });

  it('Home (DECCKM on) → ESC O H', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Home' }), ON))).toEqual([...SS3_PREFIX, 0x48]);
  });

  it('End (DECCKM on) → ESC O F', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'End' }), ON))).toEqual([...SS3_PREFIX, 0x46]);
  });

  it('Shift+Home → ESC [ 1 ; 2 H (ignores DECCKM)', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'Home', shiftKey: true }), ON)),
    ).toEqual([...CSI_PREFIX, 0x31, 0x3b, 0x32, 0x48]);
  });
});

describe('encodeLegacy — Insert/Delete/PageUp/PageDown (CSI ~)', () => {
  const rows: Array<[string, number]> = [
    ['Insert', 2],
    ['Delete', 3],
    ['PageUp', 5],
    ['PageDown', 6],
  ];
  for (const [key, code] of rows) {
    it(`${key} → ESC [ ${code} ~`, () => {
      expect(bytes(encodeLegacy(mkEvent({ key }), OFF))).toEqual([
        ...CSI_PREFIX,
        String(code).charCodeAt(0),
        0x7e,
      ]);
    });
  }

  it('Shift+Delete → ESC [ 3 ; 2 ~', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'Delete', shiftKey: true }), OFF)),
    ).toEqual([...CSI_PREFIX, 0x33, 0x3b, 0x32, 0x7e]);
  });

  it('Ctrl+PageUp → ESC [ 5 ; 5 ~', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'PageUp', ctrlKey: true }), OFF)),
    ).toEqual([...CSI_PREFIX, 0x35, 0x3b, 0x35, 0x7e]);
  });

  it('special-tilde keys do not consult DECCKM (PageDown same under both)', () => {
    const off = bytes(encodeLegacy(mkEvent({ key: 'PageDown' }), OFF));
    const on = bytes(encodeLegacy(mkEvent({ key: 'PageDown' }), ON));
    expect(off).toEqual(on);
  });
});

describe('encodeLegacy — empty-output paths', () => {
  it('modifier-only Shift key emits 0 bytes', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Shift', shiftKey: true }), OFF))).toEqual([]);
  });

  it('modifier-only Control key emits 0 bytes', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Control', ctrlKey: true }), OFF))).toEqual([]);
  });

  it('modifier-only Alt key emits 0 bytes', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Alt', altKey: true }), OFF))).toEqual([]);
  });

  it('modifier-only Meta key emits 0 bytes', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Meta', metaKey: true }), OFF))).toEqual([]);
  });

  it('Dead key (IME dead-key pseudo-event) emits 0 bytes', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'Dead' }), OFF))).toEqual([]);
  });

  it('CapsLock emits 0 bytes', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: 'CapsLock' }), OFF))).toEqual([]);
  });

  it('empty key string drops to 0 bytes', () => {
    expect(bytes(encodeLegacy(mkEvent({ key: '' }), OFF))).toEqual([]);
  });

  it('Ctrl+unknown-symbol (not in CTRL_SYMBOL) drops to 0 bytes', () => {
    // Ctrl+';' is not in CTRL_SYMBOL and not a letter → drop.
    expect(bytes(encodeLegacy(mkEvent({ key: ';', ctrlKey: true }), OFF))).toEqual([]);
  });
});

describe('encodeLegacy — repeat events', () => {
  it('repeat=true still emits the same bytes as a fresh press (legacy has no release tracking)', () => {
    const fresh = bytes(encodeLegacy(mkEvent({ key: 'a' }), OFF));
    const repeated = bytes(encodeLegacy(mkEvent({ key: 'a', repeat: true }), OFF));
    expect(repeated).toEqual(fresh);
    expect(repeated).toEqual([0x61]);
  });

  it('repeat Ctrl+C emits 0x03 every time', () => {
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'c', ctrlKey: true, repeat: true }), OFF)),
    ).toEqual([0x03]);
  });
});

describe('encodeLegacy — kind=keyup (legacy encoder ignores release state)', () => {
  it("keyup for 'a' still emits 0x61 (legacy does not branch on `kind`)", () => {
    // The legacy encoder does not inspect `kind`; only kitty L2+ honours keyup.
    // This pins the current behaviour so a future change is flagged.
    expect(
      bytes(encodeLegacy(mkEvent({ key: 'a', kind: 'keyup' }), OFF)),
    ).toEqual([0x61]);
  });
});

describe('encodeLegacy — return type invariants', () => {
  // Note: jsdom runs tests in a separate realm, so the `Uint8Array`
  // identity from the test context is not the same as the one used inside
  // the encoder. We therefore check the structural contract (length,
  // indexed byte access, toString tag) rather than `instanceof`.
  it('always returns a typed byte buffer (length + indexing)', () => {
    const out = encodeLegacy(mkEvent({ key: 'a' }), OFF);
    expect(Object.prototype.toString.call(out)).toBe('[object Uint8Array]');
    expect(typeof out.byteLength).toBe('number');
    expect(out.byteLength).toBe(1);
    expect(out[0]).toBe(0x61);
  });

  it('drop path returns a zero-length byte buffer, not null', () => {
    const out = encodeLegacy(mkEvent({ key: 'Shift', shiftKey: true }), OFF);
    expect(Object.prototype.toString.call(out)).toBe('[object Uint8Array]');
    expect(out.byteLength).toBe(0);
  });
});
