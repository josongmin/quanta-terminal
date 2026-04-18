/**
 * BlockCard — presentational tests.
 *
 * Strategy: hydrate a single block into the store, render the card with that
 * block, and assert on header/body content and click behaviour. We use the
 * actual store rather than a stub — toggleCollapse / togglePin are owned by
 * the card and we want to cover the store write path end-to-end.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { BlockCard } from '../BlockCard.js';
import type { Block } from '../../../entities/block/index.js';

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('<BlockCard />', () => {
  it('renders the command, duration, and cwd badge', () => {
    const id = useBlockStore.getState().createBlock('ls -la', '/tmp/project');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);
    // The Tooltip primitive duplicates the content inside the bubble, so we
    // match via the header's accessible name which renders once.
    expect(screen.getByRole('button', { name: /Block: ls -la/u })).toBeInTheDocument();
    expect(screen.getByLabelText('Working directory /tmp/project')).toBeInTheDocument();
    expect(screen.getByLabelText('Duration')).toBeInTheDocument();
    expect(screen.getByLabelText('Exit code 0')).toBeInTheDocument();
  });

  it('shows a spinner for a running block and no exit code', () => {
    const id = useBlockStore.getState().createBlock('sleep 9', '/');
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByRole('status', { name: /running/iu })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Exit code/u)).toBeNull();
  });

  it('decodes output bytes into the body <pre>', () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([104, 101, 108, 108, 111])); // "hello"
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByTestId('block-output')).toHaveTextContent('hello');
  });

  it('clicking the header toggles the collapsed state in the store', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const { rerender } = render(<BlockCard block={currentBlock(id)} />);
    const header = screen.getByRole('button', { name: /Block: ls/u });
    await act(async () => {
      fireEvent.click(header);
    });
    expect(useBlockStore.getState().entities[id]?.collapsed).toBe(true);
    rerender(<BlockCard block={currentBlock(id)} />);
    // Collapsed view swaps body for the peek row; the pre is gone.
    expect(screen.queryByTestId('block-output')).toBeNull();
  });

  it('clicking action buttons does NOT toggle collapse', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} onRerun={vi.fn()} onCopy={vi.fn()} />);
    const pin = screen.getByLabelText('Pin block');
    await userEvent.click(pin);
    expect(useBlockStore.getState().entities[id]?.collapsed).toBe(false);
    expect(useBlockStore.getState().entities[id]?.pinned).toBe(true);
  });

  it('invokes onRerun / onCopy with the block id', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const onRerun = vi.fn();
    const onCopy = vi.fn();
    render(<BlockCard block={currentBlock(id)} onRerun={onRerun} onCopy={onCopy} />);
    await userEvent.click(screen.getByLabelText('Rerun command'));
    await userEvent.click(screen.getByLabelText('Copy block output'));
    expect(onRerun).toHaveBeenCalledWith(id);
    expect(onCopy).toHaveBeenCalledWith(id, 'output');
  });

  it('renders the peek row with byte count when collapsed', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([65, 66, 67])); // "ABC"
    useBlockStore.getState().toggleCollapse(id);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId('block-output')).toBeNull();
    expect(screen.getByText(/3B/u)).toBeInTheDocument();
  });

  it('surfaces errorMessage in the body when status=error', () => {
    const id = useBlockStore.getState().createBlock('bad', '/');
    useBlockStore.getState().errorBlock(id, 'spawn EACCES');
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByRole('alert')).toHaveTextContent('spawn EACCES');
  });

  it('header is keyboard-activatable (Enter toggles collapse)', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    const header = screen.getByRole('button', { name: /Block: ls/u });
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(useBlockStore.getState().entities[id]?.collapsed).toBe(true);
  });

  it('incrementally accumulates spans across many chunks (no regression)', () => {
    const id = useBlockStore.getState().createBlock('stream', '/');
    const { rerender } = render(<BlockCard block={currentBlock(id)} />);
    // Feed 200 chunks — the old spread-based path allocated O(n) per chunk
    // for a total of O(n²) work. We just assert the final text arrives intact
    // and the run completes inside a generous wall-clock budget; perf
    // assertions with tight numbers are flaky in CI, so this is a smoke test
    // that catches catastrophic regressions only.
    const start = performance.now();
    act(() => {
      for (let i = 0; i < 200; i += 1) {
        useBlockStore.getState().appendBlockOutput(id, new Uint8Array([65 + (i % 26)]));
      }
    });
    rerender(<BlockCard block={currentBlock(id)} />);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5_000);
    const pre = screen.getByTestId('block-output').querySelector('pre');
    expect(pre?.textContent?.length ?? 0).toBe(200);
  });

  it('disables the Compare button when the block has no rerun lineage', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} onCompare={vi.fn()} />);
    const btn = screen.getByLabelText(/Compare \(no prior run\)/u);
    expect(btn).toBeDisabled();
  });

  it('enables and fires the Compare button when the block has a predecessor', async () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('ls', '/', { rerunOf: a });
    const onCompare = vi.fn();
    render(<BlockCard block={currentBlock(b)} onCompare={onCompare} />);
    const btn = screen.getByLabelText(/Compare against previous run/u);
    expect(btn).not.toBeDisabled();
    await userEvent.click(btn);
    expect(onCompare).toHaveBeenCalledWith(b);
  });

  it('enables the Compare button on the older block when a successor exists', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().createBlock('ls', '/', { rerunOf: a });
    render(<BlockCard block={currentBlock(a)} onCompare={vi.fn()} />);
    expect(screen.getByLabelText(/Compare against previous run/u)).not.toBeDisabled();
  });

  it('flushes parser tail spans on completion', () => {
    const id = useBlockStore.getState().createBlock('done', '/');
    // Feed a partial escape sequence — the parser holds onto it until flush.
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([0x1b, 0x5b]));
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([0x33, 0x31, 0x6d])); // "31m" — sets fg red
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([104, 105])); // "hi"
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByTestId('block-output')).toHaveTextContent('hi');
  });
});
