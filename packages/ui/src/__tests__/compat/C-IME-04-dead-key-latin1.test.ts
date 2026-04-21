/**
 * Integration test for compat fixture C-IME-04 (dead-key Latin-1).
 *
 * Plan 0005 P0 wave 4 (W). Companion to C-IME-01 (wide CJK). This
 * fixture asserts the ORTHOGONAL case: BMP Latin-1 accented characters
 * committed by a host dead-key IME must render as single width-1
 * graphemes, not as wide-leading / continuation pairs.
 *
 * Load-bearing assertion: row 0 widths are all 1s across the
 * `$ echo café résumé` sequence. A regression in the width classifier
 * (e.g. treating 2-byte UTF-8 sequences as wide) breaks this in a
 * diff-friendly way — the failing column is printed alongside the
 * expected/actual width vectors.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-IME-04',
);

describe('compat: C-IME-04 dead-key Latin-1 composition', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-IME-04'];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('interactive');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-IME-04 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
