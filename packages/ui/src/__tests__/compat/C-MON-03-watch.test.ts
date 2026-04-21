/**
 * Integration test for compat fixture C-MON-03 (watch -n 0.1 date).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: a `watch -n 0.1 date` session with 60 rapid
 * repaint frames inside the alt buffer, then C-c / DECSET 1049l exit.
 * Single load-bearing assertion: `scrollback.rowCount === 0` across all
 * 60 frames — rapid alt-repaints must never leak into the main-buffer
 * scrollback ring.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-MON-03',
);

describe('compat: C-MON-03 watch -n 0.1 date', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-MON-03'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('tui');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-MON-03 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
