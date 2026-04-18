import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import { Composer } from '../Composer.js';
import type { HostBridge } from '@quanta/host-common';

function installBridge(): { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn().mockResolvedValue(undefined);
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

beforeEach(() => {
  useSessionStore.getState().reset();
  useSessionStore.getState().setSession({ id: 'sess-1' });
});

describe('<Composer />', () => {
  it('submits on Enter and clears the input', async () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'ls -la');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      // Let the submit promise resolve before we assert on the bridge.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalledWith('sess-1', 'ls -la\n');
  });

  it('inserts a newline on Shift+Enter instead of submitting', async () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'echo');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    // Shift+Enter is a no-op at the app level; the textarea itself handles
    // the newline insertion. The key test is: submit was NOT invoked.
    expect(write).not.toHaveBeenCalled();
  });

  it('opens the recent-commands scaffold on ArrowUp at the first line', async () => {
    installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('listbox', { name: 'Recent commands' })).toBeInTheDocument();
  });

  it('does not submit empty input', () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(write).not.toHaveBeenCalled();
  });

  it('renders the mode chip with the current mode', () => {
    installBridge();
    render(<Composer mode="shell" />);
    expect(screen.getByLabelText('Composer mode: shell')).toHaveTextContent('shell');
  });
});
