/**
 * Integration test for compat fixture C-RP-02
 * (node REPL bracketed-paste multi-line).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scope: Node REPL `> ` primary prompt + a bracketed-paste block
 * (CSI 200~ / CSI 201~ delimiters). The engine has no bracketed-paste
 * state yet; the delimiters fall through the parser's "drop unknown
 * CSI" branch and contribute nothing to the grid. The pasted content
 * must render inline on consecutive rows; this fixture is the canary
 * guarding that contract against future α2 work on bracketed-paste
 * state tracking.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-RP-02',
);

describe('compat: C-RP-02 node REPL bracketed paste', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-RP-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-RP-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
