/**
 * Integration test for compat fixture C-ED-01 (vim round-trip).
 *
 * Plan 0005 P0 Epic ε — the harness proof.
 *
 * ## Why this test is stamped `.fails(...)`
 *
 * The fixture asserts the POST-Epic α contract: DECSET 1049h flips
 * `mode.alt_screen` to `true`, clears the visible grid, and stashes the
 * main buffer so 1049l restores it verbatim. Today's `VtEmulator`
 * deliberately drops 1049h/l (see its `executeDecSet` switch) and
 * hard-codes `mode_state.alt_screen: false`. That makes this test RED
 * by design — the RED serves as a tripwire: the day Epic α lands the
 * alt-buffer swap, this test flips green without any change here.
 *
 * `it.fails()` is preferred over `it.skip()` because it runs the
 * harness, confirming the ε scaffolding itself is healthy. A skipped
 * test rots silently; a failing test that EXPECTS to fail throws on
 * the first day it starts passing, forcing us to upgrade it into a
 * regular `it()` at that moment.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute fixture path, resolved from the test file's location. */
const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-ED-01',
);

describe('compat: C-ED-01 vim round-trip', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-ED-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('editor');
    expect(entry?.pending).toBeUndefined();
  });

  // Epic α landed (VtEmulator alt-buffer). Flip to green expectation.
  it(
    'replays the fixture and every checkpoint matches (green post-Epic α)',
    async () => {
      const report = await replayCompatFixture(FIXTURE_DIR);
      if (report.failedCheckpoints.length > 0) {
        // eslint-disable-next-line no-console
        console.log('failed checkpoints:', JSON.stringify(report.failedCheckpoints, null, 2));
      }
      expect(report.failedCheckpoints).toEqual([]);
      expect(report.passed).toBe(true);
    },
  );
});
