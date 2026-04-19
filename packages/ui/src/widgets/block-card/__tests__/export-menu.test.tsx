/**
 * Export menu — widget-level tests.
 *
 * Covers:
 *   - clicking the Export button opens a menu with three items;
 *   - selecting an item writes the formatted output to the clipboard;
 *   - the toast is posted with the format-specific message;
 *   - when the clipboard is absent, a warning toast surfaces without
 *     throwing;
 *   - Escape closes the menu.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
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

type ClipboardStub = { writeText: ReturnType<typeof vi.fn> };

function installClipboard(impl: (text: string) => Promise<void>): ClipboardStub {
  const writeText = vi.fn().mockImplementation(impl);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return { writeText };
}

function removeClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useToastStore.getState().clearAll();
});

afterEach(() => {
  // Leave the navigator untouched for downstream suites.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
});

describe('<BlockCard /> Export menu', () => {
  it('renders an Export button', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);
    expect(screen.getByTestId(`block-card-export-${id}`)).toBeInTheDocument();
  });

  it('opens a menu with three export format items on click', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-card-export-${id}`));
    expect(screen.getByTestId(`block-card-export-menu-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`block-card-export-markdown-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`block-card-export-json-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`block-card-export-text-${id}`)).toBeInTheDocument();
  });

  it('copies markdown to clipboard and pushes a toast', async () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([104, 105, 10]));
    useBlockStore.getState().completeBlock(id, 0);
    const clip = installClipboard(async () => {});
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-card-export-${id}`));
    await userEvent.click(screen.getByTestId(`block-card-export-markdown-${id}`));
    expect(clip.writeText).toHaveBeenCalledTimes(1);
    const written = clip.writeText.mock.calls[0]?.[0] as string;
    expect(written).toContain('## `echo hi`');
    expect(written).toContain('```\nhi\n```');
    // Toast has surfaced.
    const items = useToastStore.getState().items;
    expect(items.some((t) => /Markdown/iu.test(t.message))).toBe(true);
  });

  it('copies JSON to clipboard and pushes a toast', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    const clip = installClipboard(async () => {});
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-card-export-${id}`));
    await userEvent.click(screen.getByTestId(`block-card-export-json-${id}`));
    const written = clip.writeText.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.command).toBe('ls');
    expect(parsed.status).toBe('completed');
    const items = useToastStore.getState().items;
    expect(items.some((t) => /JSON/iu.test(t.message))).toBe(true);
  });

  it('copies plain text to clipboard, stripping ANSI', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    // "\u001b[31mred\u001b[0m\n"
    useBlockStore
      .getState()
      .appendBlockOutput(id, new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 114, 101, 100, 0x1b, 0x5b, 0x30, 0x6d, 10]));
    useBlockStore.getState().completeBlock(id, 0);
    const clip = installClipboard(async () => {});
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-card-export-${id}`));
    await userEvent.click(screen.getByTestId(`block-card-export-text-${id}`));
    const written = clip.writeText.mock.calls[0]?.[0] as string;
    expect(written).toBe('ls\nred\n');
    const items = useToastStore.getState().items;
    expect(items.some((t) => /Text/iu.test(t.message))).toBe(true);
  });

  it('surfaces a warning toast when the clipboard is not available', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    removeClipboard();
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-card-export-${id}`));
    await userEvent.click(screen.getByTestId(`block-card-export-markdown-${id}`));
    const items = useToastStore.getState().items;
    expect(items.some((t) => /failed/iu.test(t.message))).toBe(true);
  });

  it('closes the menu on Escape', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    render(<BlockCard block={currentBlock(id)} />);
    await userEvent.click(screen.getByTestId(`block-card-export-${id}`));
    expect(screen.getByTestId(`block-card-export-menu-${id}`)).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByTestId(`block-card-export-menu-${id}`)).toBeNull();
  });
});
