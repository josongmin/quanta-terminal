/**
 * BlockTagStrip — integration test.
 *
 * We render the strip inside a BlockCard (rather than in isolation) so the
 * wiring path matches production: tags arrive via the header selector,
 * chip clicks dispatch through the filter store, and the × button removes
 * via the block store. The popover is portaled — we assert against
 * document.body.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlockCard } from '../BlockCard.js';
import { useBlockStore, type Block } from '../../../entities/block/index.js';
import { useBlockFilterStore } from '../../../entities/block-filter/index.js';

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useBlockFilterStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

describe('<BlockTagStrip /> inside BlockCard', () => {
  it('renders a chip for each tag on the block', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().addTag(id, 'deploy');
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByTestId(`block-tag-chip-${id}-bug`)).toBeInTheDocument();
    expect(screen.getByTestId(`block-tag-chip-${id}-deploy`)).toBeInTheDocument();
  });

  it('clicking the × on a chip removes the tag from the block', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().addTag(id, 'deploy');
    render(<BlockCard block={currentBlock(id)} />);
    const remove = screen.getByTestId(`block-tag-remove-${id}-bug`);
    await userEvent.click(remove);
    expect(useBlockStore.getState().entities[id]?.tags).toEqual(['deploy']);
  });

  it('clicking a chip label toggles the tag in the global filter', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    render(<BlockCard block={currentBlock(id)} />);
    const label = screen.getByRole('button', { name: /Filter by tag bug/u });
    await userEvent.click(label);
    expect([...useBlockFilterStore.getState().activeTags]).toEqual(['bug']);
    await userEvent.click(label);
    expect([...useBlockFilterStore.getState().activeTags]).toEqual([]);
  });

  it('the + button opens a popover and Enter commits a new tag', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    const add = screen.getByTestId(`block-tag-add-${id}`);
    await userEvent.click(add);
    const input = screen.getByTestId(`block-tag-popover-${id}-input`);
    await userEvent.type(input, 'newtag{Enter}');
    expect(useBlockStore.getState().entities[id]?.tags).toEqual(['newtag']);
  });

  it('Escape closes the popover without committing', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-tag-add-${id}`));
    const input = screen.getByTestId(`block-tag-popover-${id}-input`);
    await userEvent.type(input, 'abandoned');
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByTestId(`block-tag-popover-${id}`)).toBeNull();
    expect(useBlockStore.getState().entities[id]?.tags).toEqual([]);
  });

  it('invalid input shows an error and keeps the popover open', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-tag-add-${id}`));
    const input = screen.getByTestId(`block-tag-popover-${id}-input`);
    await userEvent.type(input, '!!!{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Still open
    expect(screen.getByTestId(`block-tag-popover-${id}`)).toBeInTheDocument();
  });

  it('focus returns to the + button after Escape closes the popover', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    const addButton = screen.getByTestId(`block-tag-add-${id}`);
    await userEvent.click(addButton);
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(document.activeElement).toBe(addButton);
  });

  it('pressing Delete on a chip removes the tag', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().addTag(id, 'bug');
    useBlockStore.getState().addTag(id, 'deploy');
    render(<BlockCard block={currentBlock(id)} />);
    const chip = screen.getByTestId(`block-tag-chip-${id}-bug`);
    fireEvent.keyDown(chip, { key: 'Delete' });
    expect(useBlockStore.getState().entities[id]?.tags).toEqual(['deploy']);
  });
});
