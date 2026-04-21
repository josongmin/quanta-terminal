/**
 * Integration test for compat fixture C-RP-03
 * (psql `SELECT 1` round-trip).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scope: psql interactive shell `mydb=> ` prompt shape + a trivial
 * `SELECT 1;` query round-trip (header / rule / value / row count),
 * then clean `\q` back to the local shell. Banner is minimal-
 * representative (real psql output varies wildly by version).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-RP-03',
);

describe('compat: C-RP-03 psql SELECT 1', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-RP-03'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-RP-03 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
