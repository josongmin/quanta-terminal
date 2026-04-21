/**
 * Integration test for compat fixture C-PG-02 (man git-log).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: `man git-log` served through less. Covers the
 * same alt-screen lifecycle as C-PG-01 plus man-specific styling — bold
 * section headers (SGR 1) and a reverse-video status line (SGR 7) —
 * locked via `sgrDigest`. If the engine drops either SGR 1 or SGR 7
 * across the alt-buffer paint, the digests catch it.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-PG-02',
);

describe('compat: C-PG-02 man git-log', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-PG-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('pager');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-PG-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
