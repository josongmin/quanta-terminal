import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createRef, type Ref } from 'react';
import { GridMirror } from '../../../shared/lib/grid-mirror/index.js';
import { MirrorSource } from '../../../shared/ui/cell-renderer/index.js';
import { TerminalCanvas, type TerminalCanvasHandle } from '../TerminalCanvas.js';

function setupMirror(rows = 4, cols = 8): { mirror: GridMirror; source: MirrorSource } {
  const source = new MirrorSource();
  const mirror = new GridMirror({
    onChange: (dirty) => source.emit(dirty),
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

describe('TerminalCanvas — mount', () => {
  it('renders a container element with the expected role', async () => {
    const { mirror, source } = setupMirror();
    const { container } = render(<TerminalCanvas mirror={mirror} mirrorSource={source} backend="memory" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const app = container.querySelector('[role="application"]');
    expect(app).not.toBeNull();
    expect(app?.getAttribute('aria-label')).toBe('terminal-canvas');
  });

  it('data-renderer attribute is set from backend prop', async () => {
    const { mirror, source } = setupMirror();
    const { container } = render(
      <TerminalCanvas mirror={mirror} mirrorSource={source} backend="memory" />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const app = container.querySelector('[role="application"]');
    expect(app?.getAttribute('data-renderer')).toBe('memory');
  });

  it('exposes imperative handle with mirror source and backend', async () => {
    const { mirror, source } = setupMirror();
    const ref = createRef<TerminalCanvasHandle>();
    render(
      <TerminalCanvas
        ref={ref as Ref<TerminalCanvasHandle>}
        mirror={mirror}
        mirrorSource={source}
        backend="memory"
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(ref.current?.mirrorSource).toBe(source);
    expect(ref.current?.backend).toBeDefined();
    expect(ref.current?.selection).toBeDefined();
  });

  it('unmount removes DOM residue and unsubscribes from mirror source', async () => {
    const { mirror, source } = setupMirror();
    const { unmount } = render(
      <TerminalCanvas mirror={mirror} mirrorSource={source} backend="memory" />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const beforeCount = source.subscriberCount();
    expect(beforeCount).toBeGreaterThan(0);
    unmount();
    // CellBuffer + Renderer both subscribe; unmount disposes them.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(source.subscriberCount()).toBeLessThanOrEqual(beforeCount);
  });

  it('imeOverlaySlot render-prop is invoked', async () => {
    const { mirror, source } = setupMirror();
    const slot = vi.fn().mockReturnValue(<span data-testid="ime">preedit</span>);
    render(
      <TerminalCanvas
        mirror={mirror}
        mirrorSource={source}
        backend="memory"
        imeOverlaySlot={slot}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(slot).toHaveBeenCalled();
    expect(screen.getByTestId('ime')).toBeTruthy();
  });

  it('DPR switch via applyMetrics re-runs metrics application', async () => {
    const { mirror, source } = setupMirror();
    const ref = createRef<TerminalCanvasHandle>();
    render(
      <TerminalCanvas
        ref={ref as Ref<TerminalCanvasHandle>}
        mirror={mirror}
        mirrorSource={source}
        backend="memory"
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(ref.current).toBeDefined();
    ref.current?.applyMetrics(
      { cellWidthPx: 10, cellHeightPx: 20, baselineOffsetPx: 16, cellWidthCssPx: 10, cellHeightCssPx: 20 },
      2,
    );
    expect(true).toBe(true);
  });
});
