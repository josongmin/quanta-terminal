/**
 * Integration test for compat fixture C-MUX-02 (tmux-in-ssh).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scenario under test: local bash → ssh → remote shell → tmux, then
 * unwind. The engine sees a single flattened PTY stream, so the only
 * invariants are a clean alt-screen cycle + prompt round-trips.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-MUX-02',
);

describe('compat: C-MUX-02 tmux-in-ssh', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-MUX-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('tui');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-MUX-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
