import { describe, expect, it } from 'vitest';

import matrix from '../fixtures/input-matrix.json';
import { KeyEncoder } from '../KeyEncoder';
import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import type { KeyEvent, TerminalModeSnapshot } from '../types';

type MatrixCase = {
  id: string;
  mode: string;
  modeSnapshot: Omit<TerminalModeSnapshot, 'snapshotEpoch'>;
  event: KeyEvent;
  expectedBytesHex: string;
  notes?: string;
};

type MatrixFile = { version: number; cases: MatrixCase[] };

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buildSnapshot(m: Omit<TerminalModeSnapshot, 'snapshotEpoch'>): TerminalModeSnapshot {
  return Object.freeze({ ...m, snapshotEpoch: 0n });
}

const typedMatrix = matrix as unknown as MatrixFile;

describe('KeyEncoder — input matrix', () => {
  it('has at least 800 cases (G-E-04)', () => {
    expect(typedMatrix.cases.length).toBeGreaterThanOrEqual(800);
  });

  const mirror = createStubMirror();
  const encoder = new KeyEncoder({ modeSnapshot: new ModeSnapshot(mirror) });

  for (const c of typedMatrix.cases) {
    it(`case: ${c.id}`, () => {
      const snap = buildSnapshot(c.modeSnapshot);
      const out = encoder.encode(c.event, snap);
      expect(toHex(out.bytes)).toBe(c.expectedBytesHex);
      if (c.event.isComposing) {
        expect(out.diagnostics.suppressedForComposition).toBe(true);
      }
    });
  }
});

describe('KeyEncoder — diagnostics', () => {
  it('kittyKeyboard=3 produces no fallback', () => {
    const mirror = createStubMirror({ kittyKeyboard: 3 });
    const encoder = new KeyEncoder({ modeSnapshot: new ModeSnapshot(mirror) });
    const out = encoder.encode({
      key: 'a',
      code: 'KeyA',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
    });
    expect(out.diagnostics.deprecatedFallback).toBe(false);
  });

  it('kittyKeyboard > 3 clamps to kitty-3 with deprecatedFallback=true', () => {
    // We can't construct a value outside 0..3 via the typed snapshot, so
    // we stub the mirror to return a raw kittyKeyboard of 5.
    const stub = {
      snapshotMode() {
        return {
          decckm: false,
          bracketedPaste: false,
          focusReporting: false,
          mouseTracking: 'off' as const,
          mouseEncoding: 'default' as const,
          modifyOtherKeys: 0 as const,
          kittyKeyboard: 5 as unknown as 3,
          altScreen: false,
          synchronizedUpdate: false,
        };
      },
      getAppliedEpoch() {
        return 0n;
      },
    };
    const encoder = new KeyEncoder({ modeSnapshot: new ModeSnapshot(stub) });
    const out = encoder.encode({
      key: 'a',
      code: 'KeyA',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
    });
    expect(out.diagnostics.deprecatedFallback).toBe(true);
  });

  it('modeReadInconsistency stays false in a single encode()', () => {
    const mirror = createStubMirror();
    const encoder = new KeyEncoder({ modeSnapshot: new ModeSnapshot(mirror) });
    const out = encoder.encode({
      key: 'a',
      code: 'KeyA',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
    });
    expect(out.diagnostics.modeReadInconsistency).toBe(false);
  });

  it('modeReadInconsistency flips when mirror mutates between read and peek', () => {
    const mirror = createStubMirror();
    const reader = new ModeSnapshot(mirror);
    const snap = reader.read();
    mirror.applyMode({ decckm: true });
    const encoder = new KeyEncoder({ modeSnapshot: reader });
    const out = encoder.encode(
      {
        key: 'a',
        code: 'KeyA',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
      },
      snap,
    );
    expect(out.diagnostics.modeReadInconsistency).toBe(true);
  });
});

describe('KeyEncoder — DoD-E-31 anti-regression', () => {
  const modes: Array<Omit<TerminalModeSnapshot, 'snapshotEpoch'>> = [
    {
      decckm: false,
      bracketedPaste: false,
      focusReporting: false,
      mouseTracking: 'off',
      mouseEncoding: 'default',
      modifyOtherKeys: 0,
      kittyKeyboard: 0,
      altScreen: false,
      synchronizedUpdate: false,
    },
    {
      decckm: false,
      bracketedPaste: false,
      focusReporting: false,
      mouseTracking: 'off',
      mouseEncoding: 'default',
      modifyOtherKeys: 2,
      kittyKeyboard: 0,
      altScreen: false,
      synchronizedUpdate: false,
    },
  ];

  const mirror = createStubMirror();
  const encoder = new KeyEncoder({ modeSnapshot: new ModeSnapshot(mirror) });

  it('Ctrl+C / Ctrl+D / Ctrl+Z emit exactly 0x03 / 0x04 / 0x1a in legacy and mkeys=2', () => {
    for (const m of modes) {
      for (const [k, expected] of [
        ['c', '03'],
        ['d', '04'],
        ['z', '1a'],
      ] as const) {
        const snap = buildSnapshot(m);
        const out = encoder.encode(
          {
            key: k,
            code: `Key${k.toUpperCase()}`,
            ctrlKey: true,
            altKey: false,
            metaKey: false,
            shiftKey: false,
            repeat: false,
            isComposing: false,
          },
          snap,
        );
        expect(toHex(out.bytes)).toBe(expected);
      }
    }
  });
});
