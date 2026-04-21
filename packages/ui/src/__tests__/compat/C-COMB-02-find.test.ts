/**
 * Integration test for compat fixture C-COMB-02 (find / 2>/dev/null).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: 800 pathname rows force the main-buffer scroll-up
 * path + scrollback-ring growth. altScreen stays false throughout; no
 * emergency drops at this volume (harness-audit enforces globally).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-COMB-02',
);

describe('compat: C-COMB-02 find / (main-buffer stress)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-COMB-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-COMB-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.byteAccounting.droppedBytes).toBe(0);
  });
});
