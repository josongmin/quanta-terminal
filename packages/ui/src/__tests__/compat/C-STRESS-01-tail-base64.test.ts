/**
 * Integration test for compat fixture C-STRESS-01 (tail -f /dev/urandom | base64).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: continuous high-volume main-buffer output. 100
 * rows of ~76-char base64-lookalike text + \r\n scroll the viewport
 * repeatedly; the scrollback ring captures the 78 rows that fall off
 * the top. The fixture proves the main-buffer scroll-up path + ring
 * growth are correct under steady volume and that the final `^C`
 * interrupt restores a clean prompt.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-STRESS-01',
);

describe('compat: C-STRESS-01 tail | base64 (volume stress)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-STRESS-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('stress');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-STRESS-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.byteAccounting.droppedBytes).toBe(0);
  });
});
