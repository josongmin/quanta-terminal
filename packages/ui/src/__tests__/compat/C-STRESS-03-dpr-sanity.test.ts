/**
 * Integration test for compat fixture C-STRESS-03 (DPR change sanity).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: emulator state (cursor, widths, SGR) is
 * unaffected by a hypothetical device-pixel-ratio transition. The
 * fixture is a minimal `ls --color=auto` transcript; real atlas-
 * invalidation testing lives in FontAtlas / Canvas2DBackend suites.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-STRESS-03',
);

describe('compat: C-STRESS-03 DPR sanity (engine-level)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-STRESS-03'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('stress');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-STRESS-03 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
