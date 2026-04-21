/**
 * BlockCard — "Copy as Markdown" integration.
 *
 * Covers:
 *   - the export menu exposes a dedicated "Copy as Markdown" item;
 *   - clicking it writes the full-block shape (H3 + shell fence) to the
 *     clipboard and surfaces the "copied block" toast;
 *   - the window-level `quanta:copy-block-as-markdown` event (dispatched
 *     by the command palette) triggers the same action when the card has
 *     focus, and is ignored when it doesn't.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlockStore, type Block } from '../../../entities/block/index.js';
import { BlockCard } from '../BlockCard.js';
import { useToastStore } from '../../../shared/ui/toast/index.js';

function currentBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

function installClipboard(impl: (text: string) => Promise<void>) {
  const writeText = vi.fn().mockImplementation(impl);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return { writeText };
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useToastStore.getState().clearAll();
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
});

describe('<BlockCard /> Copy as Markdown', () => {
  it('exposes a Copy as Markdown menu item inside the export menu', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-card-export-${id}`));
    expect(
      screen.getByTestId(`block-card-copy-as-markdown-${id}`),
    ).toBeInTheDocument();
  });

  it('writes the full-block markdown shape when clicked', async () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([104, 105, 10]));
    useBlockStore.getState().completeBlock(id, 0);
    const clip = installClipboard(async () => {});
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-card-export-${id}`));
    await userEvent.click(screen.getByTestId(`block-card-copy-as-markdown-${id}`));
    expect(clip.writeText).toHaveBeenCalledTimes(1);
    const written = clip.writeText.mock.calls[0]?.[0] as string;
    expect(written).toContain('### `echo hi`');
    expect(written).toContain('```shell\nhi\n```');
    const toastMatch = useToastStore.getState().items.some((t) =>
      /Copied block as Markdown/iu.test(t.message),
    );
    expect(toastMatch).toBe(true);
  });

  it('responds to the palette event only when the card has focus', async () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([104, 105, 10]));
    useBlockStore.getState().completeBlock(id, 0);
    const clip = installClipboard(async () => {});
    render(<BlockCard block={currentBlock(id)} />);

    // 1. Dispatch with no focus — no-op.
    act(() => {
      window.dispatchEvent(new CustomEvent('quanta:copy-block-as-markdown'));
    });
    // Let the micro/macrotask queue drain so any copy would have landed.
    await Promise.resolve();
    expect(clip.writeText).not.toHaveBeenCalled();

    // 2. Focus the card's header (tabIndex=0 role=button) and dispatch again.
    const header = screen.getByRole('button', { name: /Block: echo hi/u });
    header.focus();
    act(() => {
      window.dispatchEvent(new CustomEvent('quanta:copy-block-as-markdown'));
    });
    // The handler is async — wait a microtask tick for the promise to resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(clip.writeText).toHaveBeenCalledTimes(1);
    const written = clip.writeText.mock.calls[0]?.[0] as string;
    expect(written).toContain('### `echo hi`');
  });
});
