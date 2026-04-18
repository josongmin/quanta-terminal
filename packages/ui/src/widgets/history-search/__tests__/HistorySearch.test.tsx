/**
 * HistorySearch widget — input/search/result-list behavior.
 *
 * The ranking is covered in depth by features/history/__tests__/search.test.ts;
 * here we only assert that the widget surfaces the hits and wires keyboard
 * navigation + Enter / Escape.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistorySearch } from '../HistorySearch.js';
import { useBlockStore } from '../../../entities/block/index.js';

function seedBlocks() {
  const a = useBlockStore.getState().createBlock('cargo test', '/repo');
  useBlockStore.getState().completeBlock(a, 0);
  const b = useBlockStore.getState().createBlock('cargo build', '/repo');
  useBlockStore.getState().completeBlock(b, 0);
  const c = useBlockStore.getState().createBlock('pnpm run dev', '/repo');
  useBlockStore.getState().completeBlock(c, 0);
  return { a, b, c };
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('<HistorySearch />', () => {
  it('renders nothing when closed', () => {
    render(<HistorySearch open={false} onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders a dialog when open', () => {
    seedBlocks();
    render(<HistorySearch open onClose={() => undefined} />);
    expect(screen.getByRole('dialog', { name: 'History search' })).toBeInTheDocument();
  });

  it('empty query renders the prompt, not results', () => {
    seedBlocks();
    render(<HistorySearch open onClose={() => undefined} />);
    expect(screen.getByText(/type to search past commands/iu)).toBeInTheDocument();
  });

  it('typing updates the result list', async () => {
    seedBlocks();
    render(<HistorySearch open onClose={() => undefined} />);
    const input = screen.getByLabelText('Search command history') as HTMLInputElement;
    await userEvent.type(input, 'cargo');
    // Two matches: "cargo test" and "cargo build".
    const options = await screen.findAllByRole('option');
    expect(options.length).toBe(2);
  });

  it('shows a "no matches" state for a non-matching query', async () => {
    seedBlocks();
    render(<HistorySearch open onClose={() => undefined} />);
    const input = screen.getByLabelText('Search command history') as HTMLInputElement;
    await userEvent.type(input, 'zzz-no-such');
    expect(screen.getByText(/no matches/iu)).toBeInTheDocument();
  });

  it('ArrowDown moves the active selection', async () => {
    seedBlocks();
    render(<HistorySearch open onClose={() => undefined} />);
    const input = screen.getByLabelText('Search command history') as HTMLInputElement;
    await userEvent.type(input, 'cargo');
    const dialog = screen.getByRole('dialog');
    // Initially first option is active. After ArrowDown, second is active.
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    const afterOpts = screen.getAllByRole('option');
    expect(afterOpts[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter fires onSelect with the active hit and closes', async () => {
    seedBlocks();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<HistorySearch open onClose={onClose} onSelect={onSelect} />);
    const input = screen.getByLabelText('Search command history') as HTMLInputElement;
    await userEvent.type(input, 'cargo test');
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalled();
    const [block] = onSelect.mock.calls[0] as [{ command: string }];
    expect(block.command).toBe('cargo test');
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes without selecting', async () => {
    seedBlocks();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<HistorySearch open onClose={onClose} onSelect={onSelect} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('backdrop click closes', () => {
    render(<HistorySearch open onClose={vi.fn()} />);
    const backdrop = screen.getByTestId('history-search-backdrop');
    const onClose = vi.fn();
    // Re-render with a spy we can read.
    render(<HistorySearch open onClose={onClose} />);
    fireEvent.mouseDown(backdrop);
    // Original widget's backdrop fires its own onClose (not this spy);
    // the second render mounts a different instance — just confirm the
    // unmount-to-click wire is present by using the second render's backdrop.
    const second = screen.getAllByTestId('history-search-backdrop').at(-1);
    expect(second).toBeDefined();
    if (second) fireEvent.mouseDown(second);
    expect(onClose).toHaveBeenCalled();
  });

  it('highlights matched tokens inside the command', async () => {
    seedBlocks();
    render(<HistorySearch open onClose={() => undefined} />);
    const input = screen.getByLabelText('Search command history') as HTMLInputElement;
    await userEvent.type(input, 'cargo');
    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(Array.from(marks).every((m) => m.textContent?.toLowerCase() === 'cargo')).toBe(true);
  });
});
