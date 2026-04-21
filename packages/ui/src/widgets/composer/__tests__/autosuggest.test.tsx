/**
 * Composer integration — inline autosuggestion (Fish-shell style).
 *
 * Seeds the block store with one completed block ("cd packages/ui"), renders
 * the Composer, types "cd ", and asserts the greyed tail is visible. Then
 * presses ArrowRight-at-end and asserts the textarea value rolls up to the
 * full completion.
 */

import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { useBlockStore } from '../../../entities/block/index.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import { Composer } from '../Composer.js';
import type { HostBridge } from '@quanta/host-common';

function installBridge(): { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn(() => Promise.resolve());
  const bridge = {
    capabilities: { editor: false, telemetry: false, settings: false, notifications: false },
    ready: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn(),
    write,
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
  } as unknown as HostBridge;
  setHostBridge(bridge);
  return { write };
}

function seedHistory(cmd: string, cwd = '/repo'): void {
  const id = useBlockStore.getState().createBlock(cmd, cwd);
  useBlockStore.getState().completeBlock(id, 0);
}

beforeEach(() => {
  useSessionStore.getState().reset();
  useSessionStore.getState().setSession({ id: 'sess-1' });
  useBlockStore.getState().resetAll();
});

describe('<Composer /> inline autosuggest', () => {
  it('shows a greyed tail matching the history entry', async () => {
    installBridge();
    seedHistory('cd packages/ui');
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'cd ');
    const ghost = await screen.findByTestId('composer-autosuggest');
    // The tail span carries the bit after "cd ".
    expect(ghost).toHaveTextContent('packages/ui');
  });

  it('ArrowRight at end-of-line accepts the completion', async () => {
    installBridge();
    seedHistory('cd packages/ui');
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'cd ');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowRight' });
      // queueMicrotask in acceptAutosuggest needs one flush.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input.value).toBe('cd packages/ui');
  });

  it('Tab accepts the completion', async () => {
    installBridge();
    seedHistory('cd packages/ui');
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'cd ');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Tab' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input.value).toBe('cd packages/ui');
  });

  it('Escape dismisses the suggestion until the value changes', async () => {
    installBridge();
    seedHistory('cd packages/ui');
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'cd ');
    expect(screen.getByTestId('composer-autosuggest')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('composer-autosuggest')).toBeNull();
    // Typing again re-surfaces the suggestion.
    await userEvent.type(input, 'p');
    expect(await screen.findByTestId('composer-autosuggest')).toBeInTheDocument();
  });

  it('does NOT suggest on an empty composer', () => {
    installBridge();
    seedHistory('cd packages/ui');
    render(<Composer autoFocus />);
    expect(screen.queryByTestId('composer-autosuggest')).toBeNull();
  });

  it('does NOT suggest when the prefix fully matches an entry', async () => {
    installBridge();
    seedHistory('cd packages/ui');
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'cd packages/ui');
    expect(screen.queryByTestId('composer-autosuggest')).toBeNull();
  });

  it('ghost text element is aria-hidden so screen readers skip it (WCAG Bug 1)', async () => {
    installBridge();
    seedHistory('cd packages/ui');
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'cd ');
    const ghost = await screen.findByTestId('composer-autosuggest');
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
  });
});
