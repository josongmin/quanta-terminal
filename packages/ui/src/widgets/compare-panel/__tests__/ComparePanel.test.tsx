import { fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { useCompareStore } from '../../../entities/compare/index.js';
import { ComparePanel } from '../ComparePanel.js';

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useCompareStore.getState().resetAll();
  setViewport(1280); // default to side-by-side
});

afterEach(() => {
  act(() => {
    useCompareStore.getState().resetAll();
  });
});

function seedPair(): { readonly leftId: string; readonly rightId: string } {
  const leftId = useBlockStore.getState().createBlock('ls', '/');
  const rightId = useBlockStore.getState().createBlock('ls', '/', { rerunOf: leftId });
  useBlockStore.getState().appendBlockOutput(leftId, new TextEncoder().encode('alpha\nbeta\n'));
  useBlockStore.getState().appendBlockOutput(rightId, new TextEncoder().encode('alpha\nBETA\n'));
  useBlockStore.getState().completeBlock(leftId, 0);
  useBlockStore.getState().completeBlock(rightId, 1);
  return { leftId, rightId };
}

describe('<ComparePanel />', () => {
  it('renders nothing when the store is closed', () => {
    render(<ComparePanel />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the dialog when opened with a valid pair', async () => {
    const { leftId, rightId } = seedPair();
    act(() => {
      useCompareStore.getState().openCompare({ leftId, rightId });
    });
    await act(async () => {
      render(<ComparePanel />);
    });
    expect(screen.getByRole('dialog', { name: 'Compare runs' })).toBeInTheDocument();
    expect(screen.getByTestId('compare-panel-side-by-side')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const { leftId, rightId } = seedPair();
    act(() => {
      useCompareStore.getState().openCompare({ leftId, rightId });
    });
    await act(async () => {
      render(<ComparePanel />);
    });
    const dialog = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    expect(useCompareStore.getState().open).toBe(false);
  });

  it('closes on backdrop mousedown', async () => {
    const { leftId, rightId } = seedPair();
    act(() => {
      useCompareStore.getState().openCompare({ leftId, rightId });
    });
    await act(async () => {
      render(<ComparePanel />);
    });
    const backdrop = screen.getByTestId('compare-panel-backdrop');
    await act(async () => {
      fireEvent.mouseDown(backdrop);
    });
    expect(useCompareStore.getState().open).toBe(false);
  });

  it('does not close on dialog interior mousedown', async () => {
    const { leftId, rightId } = seedPair();
    act(() => {
      useCompareStore.getState().openCompare({ leftId, rightId });
    });
    await act(async () => {
      render(<ComparePanel />);
    });
    const dialog = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.mouseDown(dialog);
    });
    expect(useCompareStore.getState().open).toBe(true);
  });

  it('switches to unified layout on narrow viewports', async () => {
    const { leftId, rightId } = seedPair();
    act(() => {
      useCompareStore.getState().openCompare({ leftId, rightId });
    });
    let unmount: () => void = () => {};
    await act(async () => {
      ({ unmount } = render(<ComparePanel />));
    });
    act(() => setViewport(600));
    expect(screen.getByTestId('compare-panel-unified')).toBeInTheDocument();
    unmount();
  });

  it('renders exit-code deltas in the header', async () => {
    const { leftId, rightId } = seedPair();
    act(() => {
      useCompareStore.getState().openCompare({ leftId, rightId });
    });
    await act(async () => {
      render(<ComparePanel />);
    });
    // The exit chip reads "0 → 1" when the codes differ.
    expect(screen.getByText(/0 → 1/u)).toBeInTheDocument();
  });
});
