/**
 * Integration test for compat fixture C-IME-03 (Chinese pinyin render).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scope: emulator render contract for CJK-unified-ideograph wide cells.
 * IME state machine (pinyin candidate selection) is out of scope.
 *
 * Load-bearing assertion: row 0 cols 7..14 carry the `你好世界` pairs
 *   [2,0, 2,0, 2,0, 2,0]
 * followed by a narrow `!` at col 15.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-IME-03',
);

describe('compat: C-IME-03 Chinese pinyin (render side)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-IME-03'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-IME-03 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
