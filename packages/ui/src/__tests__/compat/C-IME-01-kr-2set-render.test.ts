/**
 * Integration test for compat fixture C-IME-01 (Korean 2-set IME render).
 *
 * Plan 0005 P0 Epic ε.
 *
 * Scope: this test covers the EMULATOR'S render contract for CJK wide
 * cells. The post-IME-commit PTY bytes are fed in directly; the IME
 * state machine is out of scope (covered by
 * `packages/ui/src/features/input/ime/__tests__/korean-2set.test.ts`).
 *
 * Load-bearing assertion: the `widths` array on row 0 must follow the
 * `[1,1,1,1,1,1,1, 2,0, 2,0, 2,0, 2,0, 2,0, 1]` pattern — seven narrow
 * prompt cells, five width-2/width-0 hangul pairs, one narrow `!`. Any
 * regression in wide-cell classification or continuation storage breaks
 * this in an obvious, diff-friendly way.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-IME-01',
);

describe('compat: C-IME-01 Korean 2-set IME (render side)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-IME-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-IME-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
