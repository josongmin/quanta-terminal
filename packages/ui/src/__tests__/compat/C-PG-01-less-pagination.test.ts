/**
 * Integration test for compat fixture C-PG-01 (less /etc/passwd).
 *
 * Plan 0005 P0 Epic ε.
 *
 * Scenario under test: paging through `/etc/passwd` with `j` / `G` / `q`
 * — i.e. the full DECSET 1049 alt-screen lifecycle with a handful of
 * in-alt repaint frames and a reverse-video status line. Epic α2 (alt
 * buffer) and Epic α3 (scrollback ring) have landed, so this test is
 * green by design; if it ever regresses to red, either the alt-buffer
 * swap or one of the CSI repaint primitives has broken.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-PG-01',
);

describe('compat: C-PG-01 less /etc/passwd', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-PG-01'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('pager');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-PG-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
