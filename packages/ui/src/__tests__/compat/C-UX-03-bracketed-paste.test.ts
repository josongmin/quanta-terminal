/**
 * Integration test for compat fixture C-UX-03 (bracketed-paste round-trip).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: the engine consumes `CSI 200 ~` / `CSI 201 ~`
 * paste-start / paste-end markers as control bytes. The pasted payload
 * (`hello world!`) renders normally; the markers never appear in the
 * grid.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-UX-03',
);

describe('compat: C-UX-03 bracketed paste', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-UX-03'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-UX-03 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
