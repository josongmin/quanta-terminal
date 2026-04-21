/**
 * Integration test for compat fixture C-SH-02 (zsh 91-char prompt wrap).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: a 91-character zsh-style prompt at cols=80. The
 * fixture asserts DECAWM auto-wrap behaviour — cols 0..79 fill row 0 and
 * the remaining 11 prompt chars land on row 1 col 0..10. Command input,
 * output, and a re-wrapping second prompt round out the scenario.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-SH-02',
);

describe('compat: C-SH-02 zsh long prompt (80-col wrap)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-SH-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('shell');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-SH-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
