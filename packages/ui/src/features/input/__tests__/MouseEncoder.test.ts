import { describe, expect, it } from 'vitest';

import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import { MouseEncoder } from '../MouseEncoder';
import type { MouseEvent, TerminalModeSnapshot } from '../types';

const utf8 = new TextEncoder();

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function freeze(m: Omit<TerminalModeSnapshot, 'snapshotEpoch'>): TerminalModeSnapshot {
  return Object.freeze({ ...m, snapshotEpoch: 0n });
}

const NO_MODS = { ctrl: false, alt: false, shift: false, meta: false };

function sgr(cb: number, x: number, y: number, tail: 'M' | 'm'): string {
  const buf = new Uint8Array([0x1b, 0x5b, ...utf8.encode(`<${cb};${x};${y}`), tail === 'M' ? 0x4d : 0x6d]);
  return toHex(buf);
}

function makeEncoder(overrides: Partial<Omit<TerminalModeSnapshot, 'snapshotEpoch'>> = {}): {
  encoder: MouseEncoder;
  snapshot: TerminalModeSnapshot;
} {
  const snap = freeze({
    decckm: false,
    bracketedPaste: false,
    focusReporting: false,
    mouseTracking: 'button_event',
    mouseEncoding: 'sgr',
    modifyOtherKeys: 0,
    kittyKeyboard: 0,
    altScreen: false,
    synchronizedUpdate: false,
    ...overrides,
  });
  const encoder = new MouseEncoder({ modeSnapshot: new ModeSnapshot(createStubMirror()) });
  return { encoder, snapshot: snap };
}

describe('MouseEncoder — SGR 1006', () => {
  it.each([
    [
      'left press',
      { xCell: 3, yCell: 5, button: 'left', modifiers: NO_MODS, kind: 'press' } as MouseEvent,
      {},
      sgr(0, 4, 6, 'M'),
    ],
    [
      'left release',
      { xCell: 3, yCell: 5, button: 'left', modifiers: NO_MODS, kind: 'release' } as MouseEvent,
      {},
      sgr(0, 4, 6, 'm'),
    ],
    [
      'middle press',
      { xCell: 10, yCell: 10, button: 'middle', modifiers: NO_MODS, kind: 'press' } as MouseEvent,
      {},
      sgr(1, 11, 11, 'M'),
    ],
    [
      'right press',
      { xCell: 0, yCell: 0, button: 'right', modifiers: NO_MODS, kind: 'press' } as MouseEvent,
      {},
      sgr(2, 1, 1, 'M'),
    ],
    [
      'shift+left press',
      {
        xCell: 3,
        yCell: 5,
        button: 'left',
        modifiers: { ...NO_MODS, shift: true },
        kind: 'press',
      } as MouseEvent,
      {},
      sgr(4, 4, 6, 'M'),
    ],
    [
      'ctrl+left press',
      {
        xCell: 3,
        yCell: 5,
        button: 'left',
        modifiers: { ...NO_MODS, ctrl: true },
        kind: 'press',
      } as MouseEvent,
      {},
      sgr(16, 4, 6, 'M'),
    ],
    [
      'alt+left press',
      {
        xCell: 3,
        yCell: 5,
        button: 'left',
        modifiers: { ...NO_MODS, alt: true },
        kind: 'press',
      } as MouseEvent,
      {},
      sgr(0 | 8, 4, 6, 'M'),
    ],
    [
      'ctrl+shift+alt+left press',
      {
        xCell: 3,
        yCell: 5,
        button: 'left',
        modifiers: { ctrl: true, shift: true, alt: true, meta: false },
        kind: 'press',
      } as MouseEvent,
      {},
      sgr(0 | 16 | 4 | 8, 4, 6, 'M'),
    ],
    [
      'left drag at (10,10)',
      { xCell: 10, yCell: 10, button: 'left', modifiers: NO_MODS, kind: 'drag' } as MouseEvent,
      {},
      sgr(32, 11, 11, 'M'),
    ],
    [
      'right drag with ctrl',
      {
        xCell: 10,
        yCell: 10,
        button: 'right',
        modifiers: { ...NO_MODS, ctrl: true },
        kind: 'drag',
      } as MouseEvent,
      {},
      sgr(34 + 16, 11, 11, 'M'),
    ],
    [
      'wheel-up',
      { xCell: 5, yCell: 5, button: 'wheel-up', modifiers: NO_MODS, kind: 'wheel' } as MouseEvent,
      {},
      sgr(64, 6, 6, 'M'),
    ],
    [
      'wheel-down',
      { xCell: 5, yCell: 5, button: 'wheel-down', modifiers: NO_MODS, kind: 'wheel' } as MouseEvent,
      {},
      sgr(65, 6, 6, 'M'),
    ],
    [
      'wheel-up with shift',
      {
        xCell: 5,
        yCell: 5,
        button: 'wheel-up',
        modifiers: { ...NO_MODS, shift: true },
        kind: 'wheel',
      } as MouseEvent,
      {},
      sgr(68, 6, 6, 'M'),
    ],
    [
      'any-event move',
      { xCell: 20, yCell: 20, button: 'none', modifiers: NO_MODS, kind: 'move' } as MouseEvent,
      { mouseTracking: 'any_event' as const },
      sgr(35, 21, 21, 'M'),
    ],
    [
      'large column > 223',
      { xCell: 300, yCell: 50, button: 'left', modifiers: NO_MODS, kind: 'press' } as MouseEvent,
      {},
      sgr(0, 301, 51, 'M'),
    ],
    [
      'large row > 223',
      { xCell: 10, yCell: 300, button: 'left', modifiers: NO_MODS, kind: 'press' } as MouseEvent,
      {},
      sgr(0, 11, 301, 'M'),
    ],
  ])('%s', (_name, event, override, expected) => {
    const { encoder, snapshot } = makeEncoder(override);
    const out = encoder.encode(event, snapshot);
    expect(toHex(out.bytes)).toBe(expected);
  });

  it('click with mouseTracking=off emits empty bytes', () => {
    const { encoder, snapshot } = makeEncoder({ mouseTracking: 'off' });
    const out = encoder.encode(
      { xCell: 3, yCell: 5, button: 'left', modifiers: NO_MODS, kind: 'press' },
      snapshot,
    );
    expect(out.bytes.length).toBe(0);
  });

  it('wheel-up with tracking=off DECCKM off → 3× ArrowUp legacy with fallback flag', () => {
    const { encoder, snapshot } = makeEncoder({ mouseTracking: 'off', decckm: false });
    const out = encoder.encode(
      { xCell: 0, yCell: 0, button: 'wheel-up', modifiers: NO_MODS, kind: 'wheel' },
      snapshot,
    );
    expect(toHex(out.bytes)).toBe('1b5b411b5b411b5b41');
    expect(out.diagnostics.deprecatedFallback).toBe(true);
  });

  it('wheel-down with tracking=off DECCKM on → 3× ESC O B', () => {
    const { encoder, snapshot } = makeEncoder({ mouseTracking: 'off', decckm: true });
    const out = encoder.encode(
      { xCell: 0, yCell: 0, button: 'wheel-down', modifiers: NO_MODS, kind: 'wheel' },
      snapshot,
    );
    expect(toHex(out.bytes)).toBe('1b4f421b4f421b4f42');
  });

  it('x10 release emits empty bytes (x10 has no release)', () => {
    const { encoder, snapshot } = makeEncoder({ mouseTracking: 'x10' });
    const out = encoder.encode(
      { xCell: 3, yCell: 5, button: 'left', modifiers: NO_MODS, kind: 'release' },
      snapshot,
    );
    expect(out.bytes.length).toBe(0);
  });

  it('x10 press emits same as button_event press', () => {
    const { encoder, snapshot } = makeEncoder({ mouseTracking: 'x10' });
    const out = encoder.encode(
      { xCell: 3, yCell: 5, button: 'left', modifiers: NO_MODS, kind: 'press' },
      snapshot,
    );
    expect(toHex(out.bytes)).toBe(sgr(0, 4, 6, 'M'));
  });
});
