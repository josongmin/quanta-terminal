/**
 * Integration tests for <CommandCorrectionHint />. The hint relies on the
 * BlockCard's header view (exit code + status), so every scenario hydrates
 * a block and renders it through BlockCard — matching how the hint lives in
 * the production tree.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import type { Block } from '../../../entities/block/index.js';
import { BlockCard } from '../../../widgets/block-card/BlockCard.js';

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('<CommandCorrectionHint />', () => {
  it('renders "Did you mean `ls`?" for a single-word command that failed with exit 127', () => {
    const id = useBlockStore.getState().createBlock('lls', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 127);
    render(<BlockCard block={currentBlock(id)} />);
    const hint = screen.getByTestId(`command-correction-hint-${id}`);
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent(/Did you mean/u);
    // The Kbd renders the suggested word. Since the BlockCard header has its
    // own `<kbd>` elements we scope to the hint.
    const kbd = hint.querySelector('kbd');
    expect(kbd?.textContent).toBe('ls');
  });

  it('does NOT render the hint when exitCode is 0', () => {
    const id = useBlockStore.getState().createBlock('lls', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('does NOT render the hint when exitCode is 1 (generic error, not command-not-found)', () => {
    const id = useBlockStore.getState().createBlock('lls', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 1);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('does NOT render the hint while the block is still running', () => {
    const id = useBlockStore.getState().createBlock('lls', '/tmp/proj');
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('does NOT render the hint when the command has arguments', () => {
    const id = useBlockStore.getState().createBlock('lls -la', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 127);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('does NOT render when no correction can be found (unknown command, empty history)', () => {
    const id = useBlockStore.getState().createBlock('xyz987', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 127);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('invokes onRerunWithCorrection with the corrected command on click', async () => {
    const id = useBlockStore.getState().createBlock('gti', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 127);
    const onRerunWithCorrection = vi.fn();
    render(
      <BlockCard
        block={currentBlock(id)}
        onRerunWithCorrection={onRerunWithCorrection}
      />,
    );
    const rerun = screen.getByTestId(`command-correction-rerun-${id}`);
    await userEvent.click(rerun);
    expect(onRerunWithCorrection).toHaveBeenCalledWith(id, 'git');
  });

  it('hides the hint after clicking dismiss', async () => {
    const id = useBlockStore.getState().createBlock('lls', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 127);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByTestId(`command-correction-hint-${id}`)).toBeInTheDocument();

    const dismiss = screen.getByTestId(`command-correction-dismiss-${id}`);
    await userEvent.click(dismiss);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('dismissal persists across unrelated re-renders of the card', () => {
    const id = useBlockStore.getState().createBlock('lls', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 127);
    const { rerender } = render(<BlockCard block={currentBlock(id)} />);
    const dismiss = screen.getByTestId(`command-correction-dismiss-${id}`);
    fireEvent.click(dismiss);
    rerender(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId(`command-correction-hint-${id}`)).toBeNull();
  });

  it('prefers in-cwd history over typo map candidates when the typo map has no hit', () => {
    // Seed history: in /proj the user frequently runs "redist".
    useBlockStore.getState().createBlock('redist', '/proj');
    const okId = useBlockStore.getState().order[0]!;
    useBlockStore.getState().completeBlock(okId, 0);

    // New failing block with a similar command.
    const failId = useBlockStore.getState().createBlock('redis', '/proj');
    useBlockStore.getState().completeBlock(failId, 127);

    render(<BlockCard block={currentBlock(failId)} />);
    const hint = screen.getByTestId(`command-correction-hint-${failId}`);
    const kbd = hint.querySelector('kbd');
    expect(kbd?.textContent).toBe('redist');
    expect(hint.getAttribute('data-source')).toBe('history');
  });

  it('hint container has role="status" so screen readers announce it', () => {
    const id = useBlockStore.getState().createBlock('lls', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 127);
    render(<BlockCard block={currentBlock(id)} />);
    const hint = screen.getByTestId(`command-correction-hint-${id}`);
    expect(hint).toHaveAttribute('role', 'status');
  });

  it('rerun button has a descriptive aria-label containing the suggested correction', () => {
    const id = useBlockStore.getState().createBlock('gti', '/tmp/proj');
    useBlockStore.getState().completeBlock(id, 127);
    render(<BlockCard block={currentBlock(id)} />);
    const rerun = screen.getByTestId(`command-correction-rerun-${id}`);
    const label = rerun.getAttribute('aria-label') ?? '';
    expect(label.length).toBeGreaterThan(0);
    // The aria-label must contain the suggested correction so screen readers
    // announce it unambiguously (not just a generic "Rerun").
    expect(label).toMatch(/git/i);
  });
});
