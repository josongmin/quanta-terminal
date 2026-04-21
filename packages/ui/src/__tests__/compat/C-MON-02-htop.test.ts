/**
 * Integration test for compat fixture C-MON-02 (htop session).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: an htop-like TUI with elaborate colour painting
 * (CPU bar bg-green/bg-yellow, process state column fg-green/fg-red,
 * function-key footer). 3 full repaint frames, then a clean 1049l
 * exit. Load-bearing assertions: colour stability via `sgrDigest`, and
 * scrollback ring stays empty across all 3 frames.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-MON-02',
);

describe('compat: C-MON-02 htop', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-MON-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('tui');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-MON-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
