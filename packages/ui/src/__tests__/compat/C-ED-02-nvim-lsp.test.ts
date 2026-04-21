/**
 * Integration test for compat fixture C-ED-02 (nvim + LSP diagnostic).
 *
 * Plan 0005 P0 Epic ε.
 *
 * Scenario under test: nvim's alt-buffer lifecycle (same spine as
 * C-ED-01) plus two render-side assertions that only show up when the
 * engine preserves SGR state byte-for-byte across repaint frames:
 *
 *   - Reverse-video status line (`/tmp/hello.ts` with SGR 7).
 *   - Inline LSP diagnostic marker (SGR 48;5;203 on a single cell).
 *
 * Both are asserted via `sgrDigest`. If the emulator ever merges
 * adjacent SGR cells or drops the 256-colour bg, this fixture is the
 * canary.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-ED-02',
);

describe('compat: C-ED-02 nvim + LSP diagnostic', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-ED-02'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('editor');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-ED-02 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
