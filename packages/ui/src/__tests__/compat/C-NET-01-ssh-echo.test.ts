/**
 * Integration test for compat fixture C-NET-01
 * (ssh localhost echo hi — non-interactive round-trip).
 *
 * Plan 0005 P0 Gate #6.
 *
 * Scope: simplest SSH round-trip. Local prompt → `ssh localhost echo hi`
 * → remote `hi` output → clean disconnect → local prompt. The engine
 * never sees ssh-specific framing; from its POV this is three lines of
 * plain main-buffer transcript and `altScreen` stays false throughout.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-NET-01',
);

describe('compat: C-NET-01 ssh localhost echo hi', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-NET-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-NET-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
