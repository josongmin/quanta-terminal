/**
 * Integration test for compat fixture C-PG-03 (`more /etc/hosts`).
 *
 * Plan 0005 P0 wave 4 (W). Companion to C-PG-01 (less /etc/passwd).
 * Whereas C-PG-01 exercises the DECSET 1049 alt-buffer path, this
 * fixture asserts the OPPOSITE contract: `more` paints directly into
 * the main buffer and never toggles alt-screen.
 *
 * Load-bearing assertions:
 *   - `mode.altScreen` stays false across the whole flow.
 *   - `--More--(END)` status row carries SGR 7 inverse (sgrDigest).
 *   - Main-buffer exit leaves the shell prompt cleanly restored.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-PG-03',
);

describe('compat: C-PG-03 more /etc/hosts', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-PG-03'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('pager');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-PG-03 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
