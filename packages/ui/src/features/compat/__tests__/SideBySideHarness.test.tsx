/**
 * SideBySideHarness — component tests.
 *
 *   1. Mounts both panes with the correct data-renderer attributes.
 *   2. Forwards the shared mirrorSource: firing a dirty-row emit schedules
 *      a diff once `diffIntervalFrames` frames have elapsed.
 *   3. Export button triggers the onExportDiff callback with JSON.
 *
 * EPIC-I note (RFC 0001 §19): the harness used to mount the legacy
 * `TerminalShell` (xterm.js) on the right. With xterm removed the right
 * pane is a second `TerminalCanvas` fed from the same mirror — the
 * `xtermSnapshot` prop still injects a reference frame so the diff
 * pathway can be exercised deterministically.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GridMirror } from '../../../shared/lib/grid-mirror/index.js';
import { MirrorSource } from '../../../shared/ui/cell-renderer/index.js';
import { SideBySideHarness } from '../SideBySideHarness.js';
import { blankSnapshot } from '../side-by-side-diff.js';

function setupMirror(rows = 2, cols = 2): { mirror: GridMirror; source: MirrorSource } {
  const source = new MirrorSource();
  const mirror = new GridMirror({
    onChange: (d) => source.emit(d),
  });
  mirror.applySnapshot({
    session_id: 's',
    grid_epoch: 1,
    sequence_no: 0,
    resize_generation: 0,
    buffer_kind: 'main',
    payload: {
      kind: 'grid_snapshot',
      rows,
      cols,
      buffer_kind: 'main',
      row_deltas: [],
      cursor: {
        row: 0,
        col: 0,
        visible: true,
        shape: 'block',
        blinking: false,
        pending_wrap: false,
      },
      mode_state: {},
      meta: {},
    },
  });
  return { mirror, source };
}

afterEach(() => {
  cleanup();
});

describe('<SideBySideHarness />', () => {
  it('renders two panes with distinct data-renderer attributes', () => {
    const { mirror, source } = setupMirror();
    render(
      <SideBySideHarness
        mirror={mirror}
        mirrorSource={source}
        session={null}
        xtermSnapshot={() => blankSnapshot(2, 2)}
      />,
    );
    expect(screen.getByTestId('side-by-side-canvas').dataset['renderer']).toBe('canvas');
    // historical-xterm-reference: data-renderer="xterm" is preserved for
    // selector-stability in any e2e tooling that already targets it.
    expect(screen.getByTestId('side-by-side-xterm').dataset['renderer']).toBe('xterm');
  });

  it('records a diff snapshot once diffIntervalFrames frames have elapsed', () => {
    const { mirror, source } = setupMirror();
    const onDiff = vi.fn();
    render(
      <SideBySideHarness
        mirror={mirror}
        mirrorSource={source}
        session={null}
        diffIntervalFrames={2}
        onDiff={onDiff}
        xtermSnapshot={() => blankSnapshot(2, 2)}
      />,
    );
    // First emit does NOT yet trigger a diff.
    act(() => {
      source.emit(new Set([0]));
    });
    expect(onDiff).not.toHaveBeenCalled();
    act(() => {
      source.emit(new Set([1]));
    });
    expect(onDiff).toHaveBeenCalledTimes(1);
  });

  it('onExportDiff receives a JSON string carrying the schema header', () => {
    const { mirror, source } = setupMirror();
    const onExportDiff = vi.fn();
    render(
      <SideBySideHarness
        mirror={mirror}
        mirrorSource={source}
        session={null}
        onExportDiff={onExportDiff}
        xtermSnapshot={() => blankSnapshot(2, 2)}
      />,
    );
    const exportBtn = screen.getByRole('button', { name: /Export diff/u });
    fireEvent.click(exportBtn);
    expect(onExportDiff).toHaveBeenCalledTimes(1);
    const payload = onExportDiff.mock.calls[0]?.[0] as string;
    expect(payload).toMatch(/side-by-side-diff\/1/);
  });
});
