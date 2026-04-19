import { describe, expect, it } from 'vitest';

import rec from '../../fixtures/ime-recordings/jp-kanji-konnichiwa.json';
import { replay, type Recording } from './recording-runner';

describe('JP IME recording — konnichiwa', () => {
  const recording = rec as unknown as Recording;

  it('commits exactly the hiragana UTF-8 bytes once', () => {
    const result = replay(recording);
    expect(result.ptyBytesHex).toBe(recording.expectedPtyBytesHex);
    expect(result.midCompositionBytesHex).toEqual([]);
  });
});
