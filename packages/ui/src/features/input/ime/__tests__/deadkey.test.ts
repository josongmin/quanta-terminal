import { describe, expect, it } from 'vitest';

import eacuteRec from '../../fixtures/ime-recordings/macos-deadkey-eacute.json';
import { replay, type Recording } from './recording-runner';

describe('Dead-key IME recordings', () => {
  it('macOS Opt+e + e → é (c3 a9)', () => {
    const result = replay(eacuteRec as unknown as Recording);
    expect(result.ptyBytesHex).toBe('c3a9');
    expect(result.midCompositionBytesHex).toEqual([]);
  });

  it('macOS Opt+e + a → ä (c3 a4) — synthetic recording', () => {
    const rec: Recording = {
      id: 'deadkey-auml',
      ime: 'macos-deadkey',
      platform: 'macos',
      events: [
        { tMs: 0, kind: 'compositionstart', data: ' ' },
        { tMs: 5, kind: 'compositionupdate', data: '¨' },
        { tMs: 120, kind: 'compositionend', data: 'ä' },
      ],
      expectedPtyBytesHex: 'c3a4',
      expectedMidCompositionPtyBytes: [],
      expectedOverlayStates: [],
    };
    const result = replay(rec);
    expect(result.ptyBytesHex).toBe('c3a4');
  });

  it('macOS Opt+e + Escape → cancel, zero bytes', () => {
    const rec: Recording = {
      id: 'deadkey-escape',
      ime: 'macos-deadkey',
      platform: 'macos',
      events: [
        { tMs: 0, kind: 'compositionstart', data: ' ' },
        { tMs: 5, kind: 'compositionupdate', data: '´' },
        { tMs: 100, kind: 'keydown', key: 'Escape' },
      ],
      expectedPtyBytesHex: '',
      expectedMidCompositionPtyBytes: [],
      expectedOverlayStates: [],
    };
    const result = replay(rec);
    expect(result.ptyBytesHex).toBe('');
    expect(result.midCompositionBytesHex).toEqual([]);
  });
});
