import { describe, expect, it } from 'vitest';

import rec from '../../fixtures/ime-recordings/cn-pinyin-nihao.json';
import { replay, type Recording } from './recording-runner';

describe('CN pinyin IME recording — nihao', () => {
  const recording = rec as unknown as Recording;

  it('commits 你好 UTF-8 bytes exactly once', () => {
    const result = replay(recording);
    expect(result.ptyBytesHex).toBe(recording.expectedPtyBytesHex);
    expect(result.midCompositionBytesHex).toEqual([]);
  });
});
