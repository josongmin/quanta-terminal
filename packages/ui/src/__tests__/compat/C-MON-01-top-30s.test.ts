/**
 * Integration test for compat fixture C-MON-01 (top 30-second session).
 *
 * Plan 0005 P0 Epic ε.
 *
 * Scenario under test: three alt-buffer repaint frames that simulate
 * ~30 seconds of `top` ticks, then a clean 1049l exit. The load-bearing
 * assertion is CP 3's `scrollback.rowCount === 0` — proving that rapid
 * alt-buffer repaints NEVER feed rows into the main-buffer scrollback
 * ring. A regression there would break block-export semantics and
 * steady-state memory bounds, so this fixture is the canary.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-MON-01',
);

describe('compat: C-MON-01 top 30s', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-MON-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('tui');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-MON-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
