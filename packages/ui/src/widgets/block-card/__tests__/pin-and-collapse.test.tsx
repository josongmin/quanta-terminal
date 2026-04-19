/**
 * Audit P1 (fix 6 + fix 7) — block pin UI + collapse/expand UI.
 *
 * Fix 6: the header's pin button toggles the block's `pinned` flag; the
 * aria-label and data-active attributes swap accordingly.
 *
 * Fix 7: when collapsed, the body renders a summary line
 * `<command> · <N lines> · <duration> · exit <code>` and the full AnsiOutput
 * is hidden. Header remains keyboard-activatable (Enter and Space).
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
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

describe('BlockCard — pin button (fix 6)', () => {
  it('renders a pin button with the "Pin block" aria-label by default', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByLabelText('Pin block')).toBeInTheDocument();
  });

  it('clicking the pin button toggles the pinned flag in the store', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByLabelText('Pin block'));
    expect(useBlockStore.getState().entities[id]?.pinned).toBe(true);
  });

  it('aria-label flips to "Unpin block" once the block is pinned', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const { rerender } = render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByLabelText('Pin block'));
    rerender(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByLabelText('Unpin block')).toBeInTheDocument();
    // Clicking again flips back.
    await userEvent.click(screen.getByLabelText('Unpin block'));
    rerender(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByLabelText('Pin block')).toBeInTheDocument();
  });

  it('data-active="true" is set on the pin icon button once pinned', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const { rerender } = render(<BlockCard block={currentBlock(id)} />);
    const unpinnedBtn = screen.getByLabelText('Pin block');
    expect(unpinnedBtn).toHaveAttribute('data-active', 'false');
    await userEvent.click(unpinnedBtn);
    rerender(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByLabelText('Unpin block')).toHaveAttribute('data-active', 'true');
  });

  it('clicking the pin button does not toggle collapse', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByLabelText('Pin block'));
    expect(useBlockStore.getState().entities[id]?.collapsed).toBe(false);
  });
});

describe('BlockCard — collapse/expand UI (fix 7)', () => {
  it('expanded by default — AnsiOutput is rendered', () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([104, 105])); // "hi"
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByTestId('block-output')).toBeInTheDocument();
    expect(screen.queryByTestId(`block-summary-${id}`)).toBeNull();
  });

  it('toggleCollapse hides AnsiOutput and shows the summary row', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    const { rerender } = render(<BlockCard block={currentBlock(id)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Block: ls/u }));
    });
    rerender(<BlockCard block={currentBlock(id)} />);
    expect(screen.queryByTestId('block-output')).toBeNull();
    const summary = screen.getByTestId(`block-summary-${id}`);
    expect(summary).toBeInTheDocument();
    // "ls" · "0 lines" · some duration · "exit 0"
    expect(summary.textContent).toMatch(/^ls · 0 lines · .+ · exit 0$/u);
  });

  it('summary counts lines from output bytes (newline-terminated)', async () => {
    const id = useBlockStore.getState().createBlock('cat log', '/');
    // Three newline-terminated lines = 3 lines.
    useBlockStore.getState().appendBlockOutput(
      id,
      new Uint8Array([0x61, 0x0a, 0x62, 0x0a, 0x63, 0x0a]),
    );
    useBlockStore.getState().completeBlock(id, 0);
    useBlockStore.getState().toggleCollapse(id);
    render(<BlockCard block={currentBlock(id)} />);
    const summary = screen.getByTestId(`block-summary-${id}`);
    expect(summary.textContent).toMatch(/3 lines/u);
    expect(summary.textContent).toMatch(/exit 0/u);
  });

  it('summary counts a trailing partial line (no trailing newline)', () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([0x68, 0x69])); // "hi"
    useBlockStore.getState().completeBlock(id, 0);
    useBlockStore.getState().toggleCollapse(id);
    render(<BlockCard block={currentBlock(id)} />);
    const summary = screen.getByTestId(`block-summary-${id}`);
    expect(summary.textContent).toMatch(/1 line\b/u);
  });

  it('header keyboard Enter toggles collapse', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    const header = screen.getByRole('button', { name: /Block: ls/u });
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(useBlockStore.getState().entities[id]?.collapsed).toBe(true);
  });

  it('header keyboard Space toggles collapse', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    render(<BlockCard block={currentBlock(id)} />);
    const header = screen.getByRole('button', { name: /Block: ls/u });
    fireEvent.keyDown(header, { key: ' ' });
    expect(useBlockStore.getState().entities[id]?.collapsed).toBe(true);
  });

  it('summary omits the exit segment when the block has no exit code yet (still running)', () => {
    const id = useBlockStore.getState().createBlock('sleep 9', '/');
    useBlockStore.getState().toggleCollapse(id);
    render(<BlockCard block={currentBlock(id)} />);
    const summary = screen.getByTestId(`block-summary-${id}`);
    expect(summary.textContent).not.toMatch(/exit /u);
  });
});
