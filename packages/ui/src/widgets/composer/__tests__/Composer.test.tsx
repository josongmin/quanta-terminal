import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import { Composer } from '../Composer.js';
import type { HostBridge } from '@quanta/host-common';

function installBridge(writeImpl?: (sessionId: string, data: string) => Promise<void>): {
  write: ReturnType<typeof vi.fn>;
} {
  const write = vi.fn(writeImpl ?? (() => Promise.resolve()));
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

/** Dispatch a real composition event. jsdom has only the constructors,
 *  but CompositionEvent is available and React will bubble it to our handler. */
function dispatchComposition(el: HTMLElement, type: 'compositionstart' | 'compositionend'): void {
  const ev = new CompositionEvent(type, { bubbles: true, data: '' });
  el.dispatchEvent(ev);
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

  it('does NOT submit on Enter while an IME composition is active', async () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'こん'); // representative IME text
    // Begin composition: the next Enter is a candidate confirm, not a submit.
    dispatchComposition(input, 'compositionstart');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(write).not.toHaveBeenCalled();
    // After compositionend, the SAME Enter should NOT retroactively submit,
    // but a fresh Enter DOES submit.
    dispatchComposition(input, 'compositionend');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalledWith('sess-1', 'こん\n');
  });

  it('respects the native isComposing flag (Safari path)', () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    // nativeEvent.isComposing === true: treat as IME, don't submit.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true } as unknown as KeyboardEventInit);
    expect(write).not.toHaveBeenCalled();
  });

  it('paste of multi-line text preserves newlines without extra submits', () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    // Simulate paste by firing a change event with \n in the value — the
    // textarea ingests the pasted string as a single change, not per-char.
    fireEvent.change(input, { target: { value: 'line1\nline2\nline3' } });
    expect(input.value).toBe('line1\nline2\nline3');
    // Nothing submitted by the paste alone — submit only happens on Enter.
    expect(write).not.toHaveBeenCalled();
  });

  it('surfaces a non-blocking error when bridge.write rejects', async () => {
    const { write } = installBridge(() => Promise.reject(new Error('pipe closed')));
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'ls');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalled();
    const alert = await screen.findByTestId('composer-error');
    expect(alert).toHaveTextContent(/bridge\.write rejected/iu);
    expect(alert).toHaveTextContent(/pipe closed/iu);
    // Text is preserved so the user can retry.
    expect(input.value).toBe('ls');
  });

  it('clears the error the moment the user types again', async () => {
    installBridge(() => Promise.reject(new Error('pipe closed')));
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'ls');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('composer-error')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'ls -la' } });
    expect(screen.queryByTestId('composer-error')).toBeNull();
  });

  it('renders RTL text round-trip (jsdom cannot assert visual order)', async () => {
    installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'مرحبا');
    expect(input.value).toBe('مرحبا');
  });
});
