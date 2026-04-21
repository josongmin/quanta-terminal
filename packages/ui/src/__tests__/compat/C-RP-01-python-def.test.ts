/**
 * Integration test for compat fixture C-RP-01 (python3 multi-line def).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scope: Python REPL primary `>>> ` + continuation `... ` prompt
 * cycle across a multi-line `def` block, followed by a function call
 * that prints `42`, then a clean `exit()`. Asserts prompt shape, row
 * layout, and scrollback invariant.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-RP-01',
);

describe('compat: C-RP-01 python3 multi-line def', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-RP-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-RP-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
