/**
 * Integration test for compat fixture C-STRESS-02 (cat 100mb.log → eviction).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: 15 000 rows force the scrollback ring past its
 * 10 000-row default cap. Verifies the ring caps correctly and the
 * head walks forward on eviction — any regression that lets the ring
 * grow unbounded would fail the rowCount assertion.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-STRESS-02',
);

describe('compat: C-STRESS-02 cat 100mb.log (scrollback eviction)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-STRESS-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('stress');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-STRESS-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.byteAccounting.droppedBytes).toBe(0);
  });
});
