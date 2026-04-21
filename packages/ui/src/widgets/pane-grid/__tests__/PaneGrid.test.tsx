/**
 * PaneGrid widget tests.
 *
 * Covers:
 *   - A single-leaf tree renders the renderPane callback with the leaf's
 *     session id once; empty tree falls back to `renderFallback`.
 *   - A 2-leaf split renders both leaves and mounts a resizer between them.
 *   - `computeRatioFromEvent` returns the correct ratio for both axes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PaneGrid, computeRatioFromEvent } from '../PaneGrid.js';
import { usePaneStore } from '../../../entities/pane/index.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;

beforeEach(() => {
  usePaneStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('<PaneGrid />', () => {
  it('renders the fallback when the tree is empty', () => {
    render(
      <PaneGrid
        renderPane={() => <div data-testid="pane-body" />}
        renderFallback={() => <div data-testid="fallback" />}
      />,
    );
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('pane-body')).toBeNull();
  });

  it('renders a single pane when the tree is a single leaf', () => {
    usePaneStore.getState().setRoot(A);
    const renderPane = vi.fn(
      (id: SessionId) => <div data-testid={`body-${id}`}>{String(id)}</div>,
    );
    render(<PaneGrid renderPane={renderPane} />);
    expect(renderPane).toHaveBeenCalledTimes(1);
    expect(renderPane).toHaveBeenCalledWith(A, true);
    expect(screen.getByTestId(`body-${A}`)).toBeInTheDocument();
  });

  it('renders two leaves and a resizer when the tree is a horizontal split', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);

    render(
      <PaneGrid
        renderPane={(id) => <div data-testid={`body-${id}`}>{String(id)}</div>}
      />,
    );

    expect(screen.getByTestId(`body-${A}`)).toBeInTheDocument();
    expect(screen.getByTestId(`body-${B}`)).toBeInTheDocument();
    expect(screen.getByTestId('pane-resizer-root')).toBeInTheDocument();
    const split = screen.getByTestId('pane-split-root');
    expect(split.dataset['direction']).toBe('horizontal');

    // The right child (B) is focused after splitting.
    const leafB = screen.getByTestId(`pane-leaf-${B}`);
    expect(leafB.dataset['active']).toBe('true');
    const leafA = screen.getByTestId(`pane-leaf-${A}`);
    expect(leafA.dataset['active']).toBe('false');
  });
});

describe('<PaneGrid /> — zoom rendering', () => {
  it('renders a zoom badge on the zoomed leaf and hides the sibling wrapper', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B); // focus on B
    s.zoomPane(B);

    render(
      <PaneGrid renderPane={(id) => <div data-testid={`body-${id}`}>{String(id)}</div>} />,
    );

    // Badge present on B, absent on A.
    const leafB = screen.getByTestId(`pane-leaf-${B}`);
    expect(leafB.dataset['zoomed']).toBe('true');
    expect(screen.getByTestId('pane-zoom-badge')).toBeInTheDocument();

    // Sibling wrapper has the hiddenForZoom class.
    const siblingWrap = screen.getByTestId('pane-wrap-0');
    expect(siblingWrap.className).toMatch(/hiddenForZoom/);

    // Both session renderers are still mounted — zoom hides visually, not
    // via unmount. This preserves session state across zoom toggles.
    expect(screen.getByTestId(`body-${A}`)).toBeInTheDocument();
    expect(screen.getByTestId(`body-${B}`)).toBeInTheDocument();
  });

  it('removes the badge and un-hides siblings when zoom is cleared', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);
    s.zoomPane(B);
    const { rerender } = render(
      <PaneGrid renderPane={(id) => <div data-testid={`body-${id}`}>{String(id)}</div>} />,
    );
    expect(screen.getByTestId('pane-zoom-badge')).toBeInTheDocument();

    // Unzoom and re-render; the badge must disappear. The unzoom triggers
    // a store subscription which flushes a React re-render — wrap in act()
    // to silence the async-update warning.
    act(() => {
      s.unzoomPane();
    });
    rerender(
      <PaneGrid renderPane={(id) => <div data-testid={`body-${id}`}>{String(id)}</div>} />,
    );
    expect(screen.queryByTestId('pane-zoom-badge')).toBeNull();
    const siblingWrap = screen.getByTestId('pane-wrap-0');
    expect(siblingWrap.className).not.toMatch(/hiddenForZoom/);
  });
});

describe('computeRatioFromEvent', () => {
  it('returns (clientX - left) / width for horizontal splits', () => {
    const rect = { left: 100, top: 0, width: 400, height: 300 };
    expect(computeRatioFromEvent('horizontal', rect, 200, 150)).toBeCloseTo(0.25);
    expect(computeRatioFromEvent('horizontal', rect, 400, 150)).toBeCloseTo(0.75);
  });

  it('returns (clientY - top) / height for vertical splits', () => {
    const rect = { left: 0, top: 40, width: 400, height: 200 };
    expect(computeRatioFromEvent('vertical', rect, 150, 90)).toBeCloseTo(0.25);
    expect(computeRatioFromEvent('vertical', rect, 150, 190)).toBeCloseTo(0.75);
  });

  it('defaults to 0.5 when the container has zero size', () => {
    const zeroRect = { left: 0, top: 0, width: 0, height: 0 };
    expect(computeRatioFromEvent('horizontal', zeroRect, 10, 10)).toBe(0.5);
    expect(computeRatioFromEvent('vertical', zeroRect, 10, 10)).toBe(0.5);
  });
});
