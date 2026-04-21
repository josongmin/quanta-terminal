/**
 * Integration test for compat fixture C-COMB-03 (yes | head -c 1G, lightweight).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: 50 000 × `y\r\n` force 5× overflow of the
 * 10 000-row scrollback cap. rowCount stays pinned at the cap;
 * droppedBytes stays 0.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-COMB-03',
);

describe('compat: C-COMB-03 yes | head (cap-enforcement stress)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-COMB-03'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-COMB-03 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.byteAccounting.droppedBytes).toBe(0);
  });
});
