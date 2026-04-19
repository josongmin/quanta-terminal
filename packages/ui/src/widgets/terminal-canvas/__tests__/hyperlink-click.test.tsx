import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { GridMirror } from '../../../shared/lib/grid-mirror/index.js';
import { MirrorSource } from '../../../shared/ui/cell-renderer/index.js';
import { TerminalCanvas } from '../TerminalCanvas.js';

function mount(rows = 4, cols = 8): { mirror: GridMirror; source: MirrorSource } {
  const source = new MirrorSource();
  const mirror = new GridMirror({ onChange: (d) => source.emit(d) });
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

describe('TerminalCanvas — hyperlink click', () => {
  it('plain click does not fire onHyperlinkClick', async () => {
    const { mirror, source } = mount();
    const onHyperlinkClick = vi.fn();
    const { container } = render(
      <TerminalCanvas
        mirror={mirror}
        mirrorSource={source}
        backend="memory"
        onHyperlinkClick={onHyperlinkClick}
        platform="macos"
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const app = container.querySelector('[role="application"]') as HTMLElement;
    fireEvent.pointerDown(app, {
      clientX: 10,
      clientY: 5,
      pointerId: 1,
      detail: 1,
    });
    expect(onHyperlinkClick).not.toHaveBeenCalled();
  });

  it('exposes platform attribute on the root element', async () => {
    const { mirror, source } = mount();
    const { container } = render(
      <TerminalCanvas mirror={mirror} mirrorSource={source} backend="memory" platform="linux" />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const app = container.querySelector('[role="application"]') as HTMLElement;
    expect(app.getAttribute('data-platform')).toBe('linux');
  });

  it('selection begins on pointerdown and extends on pointermove', async () => {
    const { mirror, source } = mount();
    const onSelectionChange = vi.fn();
    const { container } = render(
      <TerminalCanvas
        mirror={mirror}
        mirrorSource={source}
        backend="memory"
        platform="linux"
        onSelectionChange={onSelectionChange}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const app = container.querySelector('[role="application"]') as HTMLElement;
    fireEvent.pointerDown(app, { clientX: 5, clientY: 5, pointerId: 1, detail: 1 });
    fireEvent.pointerMove(app, { clientX: 40, clientY: 5, pointerId: 1 });
    fireEvent.pointerUp(app, { clientX: 40, clientY: 5, pointerId: 1 });
    expect(onSelectionChange).toHaveBeenCalled();
  });
});
