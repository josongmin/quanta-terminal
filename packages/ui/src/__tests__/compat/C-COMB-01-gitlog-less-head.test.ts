/**
 * Integration test for compat fixture C-COMB-01 (git log | less | head -20).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: pipe + pager + head combinator. less enters the
 * alt buffer, paints 20 commit rows, exits on EOF. Asserts alt-buffer
 * content never leaks into the main-buffer scrollback ring.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-COMB-01',
);

describe('compat: C-COMB-01 git log | less | head', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-COMB-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-COMB-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
