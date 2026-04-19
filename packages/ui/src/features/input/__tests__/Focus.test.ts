import { describe, expect, it } from 'vitest';

import { Focus } from '../Focus';
import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import type { TerminalModeSnapshot } from '../types';

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function snap(fr: boolean): TerminalModeSnapshot {
  return Object.freeze({
    decckm: false,
    bracketedPaste: false,
    focusReporting: fr,
    mouseTracking: 'off' as const,
    mouseEncoding: 'default' as const,
    modifyOtherKeys: 0 as const,
    kittyKeyboard: 0 as const,
    altScreen: false,
    synchronizedUpdate: false,
    snapshotEpoch: 0n,
  });
}

describe('Focus encoder', () => {
  const focus = new Focus({ modeSnapshot: new ModeSnapshot(createStubMirror()) });

  it('no bytes when focus reporting is off — focus', () => {
    const out = focus.encode({ focused: true }, snap(false));
    expect(out.bytes.length).toBe(0);
  });
  it('no bytes when focus reporting is off — blur', () => {
    const out = focus.encode({ focused: false }, snap(false));
    expect(out.bytes.length).toBe(0);
  });
  it('ESC [ I on focus', () => {
    const out = focus.encode({ focused: true }, snap(true));
    expect(toHex(out.bytes)).toBe('1b5b49');
  });
  it('ESC [ O on blur', () => {
    const out = focus.encode({ focused: false }, snap(true));
    expect(toHex(out.bytes)).toBe('1b5b4f');
  });
});
