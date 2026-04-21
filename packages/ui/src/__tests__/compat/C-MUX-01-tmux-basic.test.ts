/**
 * Integration test for compat fixture C-MUX-01 (tmux basic).
 *
 * Plan 0005 P0 Epic ε.
 *
 * Scenario under test: tmux's alt-buffer lifecycle with a split-pane
 * repaint. Real tmux is a user of the alt buffer + absolute cursor
 * moves; from our emulator's POV, its bytes are no more exotic than
 * less or top. Checkpoints assert:
 *
 *   - Alt-buffer entry/exit.
 *   - Status line preserves SGR 7 inverse (via `sgrDigest`).
 *   - After the split-horizontal paint, row 0 shows the upper-pane
 *     prompt and row N/2 shows the lower-pane prompt.
 *
 * Category note: the fixture ID prefix is `C-MUX-*` but the registry
 * `CompatCategory` enum has no `'mux'` variant. tmux is a full-screen
 * TUI by the definition used for `C-TUI-*`, so this fixture is
 * bucketed under `'tui'`. See the fixture's README for rationale.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { replayCompatFixture } from './compat-replay.js';
import { COMPAT_FIXTURES } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/compat/C-MUX-01',
);

describe('compat: C-MUX-01 tmux basic (new + split + detach)', () => {
  it('registry entry exists and is not pending', () => {
    const entry = COMPAT_FIXTURES['C-MUX-01'];
    expect(entry).toBeDefined();
    // `mux` isn't a CompatCategory; tmux lives under `tui`.
    expect(entry?.category).toBe('tui');
    expect(entry?.pending).toBeUndefined();
  });

  it('replays the fixture and every checkpoint matches', async () => {
    const report = await replayCompatFixture(FIXTURE_DIR);
    if (report.failedCheckpoints.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'C-MUX-01 failed checkpoints:',
        JSON.stringify(report.failedCheckpoints, null, 2),
      );
    }
    expect(report.failedCheckpoints).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
