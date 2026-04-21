/**
 * Integration test for compat fixture C-IME-02 (Japanese IME render).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scope: emulator render contract for JP hiragana wide cells. IME state
 * machine is out of scope (host-layer concern).
 *
 * Load-bearing assertion: row 0 `widths` array must be
 *   [1,1,1,1,1,1,1, 2,0, 2,0, 2,0, 2,0, 2,0, 1, ...]
 * Seven narrow prompt cells + five width-2/width-0 hiragana pairs +
 * one narrow `!`.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-IME-02',
);

describe('compat: C-IME-02 Japanese IME (render side)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-IME-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-IME-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
