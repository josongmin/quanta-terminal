/**
 * Integration test for compat fixture C-NET-02
 * (remote bash over ssh, `cd /etc; ls`, `exit`).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scope: multi-turn interactive SSH session. Asserts MOTD banner
 * visibility, remote `user@host:` prompt shape, cwd-via-prompt
 * heuristic after `cd /etc`, `ls` output containing `passwd`, and
 * clean return to the local shell on `exit`.
 *
 * Note: the cwd assertion is a PROMPT-MATCH heuristic. P1-SI will
 * replace it with OSC 7 reads once the engine supports authoritative
 * cwd reporting.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-NET-02',
);

describe('compat: C-NET-02 ssh + cd /etc + ls', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-NET-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-NET-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
