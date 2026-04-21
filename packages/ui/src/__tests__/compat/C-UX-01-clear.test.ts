/**
 * Integration test for compat fixture C-UX-01 (`clear` behaviour).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: after a handful of `ls` output rows + prompt,
 * a `clear` sequence (CSI H + CSI 2J) wipes the viewport and homes the
 * cursor. Scrollback ring survives (no CSI 3J emitted).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-UX-01',
);

describe('compat: C-UX-01 clear (CSI H + CSI 2J)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-UX-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-UX-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
