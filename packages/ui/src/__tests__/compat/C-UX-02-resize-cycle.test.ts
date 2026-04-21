/**
 * Integration test for compat fixture C-UX-02 (resize cycle).
 *
 * Plan 0005 P0 Gate #6 closing. Replays a minimal `ls` transcript,
 * then cycles `emulator.resize()` 10 times between 80×24 and 200×50
 * (5 round-trips). Every checkpoint re-projects the main buffer and
 * asserts the pinned rows survived the reflow.
 *
 * This fixture is the canary for the compat harness's in-stream
 * `resize` hook (see `compat-replay.ts` CheckpointExpected.resize).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-UX-02',
);

describe('compat: C-UX-02 resize cycle (80×24 ↔ 200×50 ×5)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-UX-02'];
    expect(entry).toBeDefined();
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture; all 10 resize cycles preserve main buffer content', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-UX-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
