/**
 * BlockFilterBar — rendering + click interactions.
 *
 * We render via the full BlockList so the contract "bar shows iff any tag
 * is active, reports matched/total counts, clears filter on button" is
 * verified end to end against the real composed stores.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlockList } from '../BlockList.js';
import { useBlockStore } from '../../../entities/block/index.js';
import { useBlockFilterStore } from '../../../entities/block-filter/index.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useBlockFilterStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

describe('<BlockFilterBar /> via <BlockList />', () => {
  it('is hidden when no tag is active', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockList />);
    expect(screen.queryByTestId('block-filter-bar')).toBeNull();
  });

  it('appears with a chip when a tag is activated', async () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(a, 'bug');
    useBlockStore.getState().completeBlock(a, 0);

    act(() => {
      useBlockFilterStore.getState().addTag('bug');
    });

    render(<BlockList />);
    expect(screen.getByTestId('block-filter-bar')).toBeInTheDocument();
    expect(screen.getByTestId('block-filter-chip-bug')).toBeInTheDocument();
  });

  it('clear button resets the filter', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().completeBlock(id, 0);
    act(() => {
      useBlockFilterStore.getState().addTag('bug');
    });
    render(<BlockList />);
    await userEvent.click(screen.getByTestId('block-filter-clear'));
    expect(useBlockFilterStore.getState().activeTags.size).toBe(0);
  });

  it('applies the filter: only matching blocks remain visible', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('pwd', '/');
    useBlockStore.getState().addTag(a, 'deploy');
    // b: untagged
    useBlockStore.getState().completeBlock(a, 0);
    useBlockStore.getState().completeBlock(b, 0);

    act(() => {
      useBlockFilterStore.getState().addTag('deploy');
    });
    render(<BlockList />);
    expect(screen.queryByTestId(`block-card-${a}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`block-card-${b}`)).toBeNull();
  });

  it('reports matched of total counts', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    const b = useBlockStore.getState().createBlock('b', '/');
    const c = useBlockStore.getState().createBlock('c', '/');
    useBlockStore.getState().addTag(a, 'deploy');
    useBlockStore.getState().addTag(b, 'deploy');
    [a, b, c].forEach((id) => useBlockStore.getState().completeBlock(id, 0));

    act(() => {
      useBlockFilterStore.getState().addTag('deploy');
    });
    render(<BlockList />);
    expect(screen.getByTestId('block-filter-count').textContent).toMatch(/2.*3/u);
  });

  it('Clear button has aria-label "Clear all tag filters"', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().completeBlock(id, 0);
    act(() => {
      useBlockFilterStore.getState().addTag('bug');
    });
    render(<BlockList />);
    expect(screen.getByTestId('block-filter-clear')).toHaveAttribute(
      'aria-label',
      'Clear all tag filters',
    );
  });

  it('count span has aria-live="polite"', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().completeBlock(id, 0);
    act(() => {
      useBlockFilterStore.getState().addTag('bug');
    });
    render(<BlockList />);
    expect(screen.getByTestId('block-filter-count')).toHaveAttribute('aria-live', 'polite');
  });

  it('Delete key on a filter chip removes that filter tag', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().completeBlock(id, 0);
    act(() => {
      useBlockFilterStore.getState().addTag('bug');
    });
    render(<BlockList />);
    const chip = screen.getByTestId('block-filter-chip-bug');
    fireEvent.keyDown(chip, { key: 'Delete' });
    expect(useBlockFilterStore.getState().activeTags.size).toBe(0);
  });
});
