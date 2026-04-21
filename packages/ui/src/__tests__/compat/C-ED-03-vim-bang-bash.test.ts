/**
 * Integration test for compat fixture C-ED-03 (vim `:!bash` nested subshell).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: vim enters alt-screen (DECSET 1049h), spawns a
 * subshell with `:!bash`, the inner bash runs WITHOUT its own 1049
 * cycle, and vim exits on `:q!` with DECSET 1049l. The load-bearing
 * assertion is that `alt_screen` flips exactly ONCE on the outer 1049h
 * and stays true across the entire nested bash lifecycle. Any extra
 * flip would indicate that the engine is treating the inner shell as
 * its own alt-screen cycle, which would break block semantics.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-ED-03',
);

describe('compat: C-ED-03 vim :!bash nested subshell', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-ED-03'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('editor');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-ED-03 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
