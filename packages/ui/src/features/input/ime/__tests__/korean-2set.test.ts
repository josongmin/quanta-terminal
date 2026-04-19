import { describe, expect, it } from 'vitest';

import commitRec from '../../fixtures/ime-recordings/korean-2set-commit.json';
import escRec from '../../fixtures/ime-recordings/korean-2set-esc-cancel.json';
import blurRec from '../../fixtures/ime-recordings/korean-2set-macos-blur.json';
import { replay, type Recording } from './recording-runner';

const recordings: Recording[] = [
  commitRec as unknown as Recording,
  escRec as unknown as Recording,
  blurRec as unknown as Recording,
];

describe('Korean 2-set IME recordings', () => {
  for (const rec of recordings) {
    it(`${rec.id}: PTY bytes + mid-composition empty + overlay trace`, () => {
      const result = replay(rec);
      expect(result.ptyBytesHex).toBe(rec.expectedPtyBytesHex);
      // I-1, I-2 anti-regression: no bytes during composition.
      expect(result.midCompositionBytesHex).toEqual([]);
      expect(rec.expectedMidCompositionPtyBytes).toEqual([]);
      // Overlay trace — endpoints must match.
      const firstExpected = rec.expectedOverlayStates[0];
      if (firstExpected) {
        const firstActual = result.overlayTrace[0];
        expect(firstActual?.visible).toBe(firstExpected.visible);
        expect(firstActual?.text).toBe(firstExpected.text);
      }
      const last = rec.expectedOverlayStates.at(-1);
      if (last) {
        const lastActual = result.overlayTrace.at(-1);
        expect(lastActual?.visible).toBe(last.visible);
        expect(lastActual?.text).toBe(last.text);
      }
    });
  }

  it('RFC §22 #1: korean-2set-commit emits exactly ed 95 9c once', () => {
    const result = replay(recordings[0]!);
    expect(result.ptyBytesHex).toBe('ed959c');
    expect(result.midCompositionBytesHex).toEqual([]);
  });
});
