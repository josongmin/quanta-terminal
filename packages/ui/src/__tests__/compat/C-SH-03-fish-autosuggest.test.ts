/**
 * Integration test for compat fixture C-SH-03 (fish autosuggest ghost text).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: fish's inline autosuggestion — bytes printed in
 * SGR 90 (bright-black fg) followed by a `CSI n D` cursor-back pulling
 * the cursor onto the start of the ghost span. The load-bearing
 * assertion is a row-level `sgrDigest` proving the ghost cells carry
 * fg=bright:0 while the typed prefix stays default.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-SH-03',
);

describe('compat: C-SH-03 fish autosuggest ghost text', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-SH-03'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('shell');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-SH-03 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
