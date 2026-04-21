/**
 * Integration test for compat fixture C-SH-01 (bash: ls, cd, pwd, echo).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: pure main-buffer shell loop. No alt-screen, no SGR.
 * Four command turns (`ls`, `cd /tmp`, `pwd`, `echo $?`) with their
 * outputs. The fixture proves the baseline case: `\r\n`, printable text,
 * and cursor advancement all behave correctly across multiple command
 * turns and the scrollback ring stays at zero (no rows evicted).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-SH-01',
);

describe('compat: C-SH-01 bash (ls, cd, pwd, echo)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-SH-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('shell');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-SH-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
