import { describe, expect, it } from 'vitest';

import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import { Paste } from '../Paste';
import type { TerminalModeSnapshot } from '../types';

const utf8 = new TextEncoder();

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function snapshotWith(bp: boolean): TerminalModeSnapshot {
  return Object.freeze({
    decckm: false,
    bracketedPaste: bp,
    focusReporting: false,
    mouseTracking: 'off' as const,
    mouseEncoding: 'default' as const,
    modifyOtherKeys: 0 as const,
    kittyKeyboard: 0 as const,
    altScreen: false,
    synchronizedUpdate: false,
    snapshotEpoch: 0n,
  });
}

describe('Paste encoder', () => {
  const paste = new Paste({ modeSnapshot: new ModeSnapshot(createStubMirror()) });

  it('raw passthrough when bracketed paste is off', () => {
    const out = paste.encode({ text: 'hello', length: 5 }, snapshotWith(false));
    expect(toHex(out.bytes)).toBe(toHex(utf8.encode('hello')));
  });

  it('wraps payload with sentinels when bracketed paste is on', () => {
    const out = paste.encode({ text: 'hello', length: 5 }, snapshotWith(true));
    const expected = toHex(utf8.encode('\x1b[200~hello\x1b[201~'));
    expect(toHex(out.bytes)).toBe(expected);
  });

  it('preserves embedded newlines when bp is off', () => {
    const out = paste.encode({ text: 'line1\nline2', length: 11 }, snapshotWith(false));
    expect(toHex(out.bytes)).toBe(toHex(utf8.encode('line1\nline2')));
  });

  it('wraps multi-line payloads when bp is on', () => {
    const out = paste.encode({ text: 'line1\nline2', length: 11 }, snapshotWith(true));
    expect(toHex(out.bytes)).toBe(toHex(utf8.encode('\x1b[200~line1\nline2\x1b[201~')));
  });

  it('filters embedded sentinel sequences from the payload', () => {
    const out = paste.encode(
      { text: 'has\x1b[200~embedded\x1b[201~sequence', length: 30 },
      snapshotWith(true),
    );
    expect(toHex(out.bytes)).toBe(toHex(utf8.encode('\x1b[200~hasembeddedsequence\x1b[201~')));
  });

  it('wraps empty paste', () => {
    const out = paste.encode({ text: '', length: 0 }, snapshotWith(true));
    expect(toHex(out.bytes)).toBe(toHex(utf8.encode('\x1b[200~\x1b[201~')));
  });
});
