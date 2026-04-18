/**
 * TerminalPage view-state transition tests.
 *
 * The page switches between `<EmptyState />`, `<LoadingState />`, `<ErrorState />`
 * and `<TerminalShell />` based on the session store's `id` + `health` pair.
 * These tests drive the store directly — they do not mount the real bridge
 * (that path is covered end-to-end in `connect.test.ts` and the browser).
 *
 * The tests deliberately avoid rendering the real `<TerminalShell />`: xterm.js
 * pulls in WebGL and a stylesheet that jsdom cannot satisfy. We stub the widget
 * with a lightweight marker so the surrounding chrome renders and transitions
 * are observable without spinning up a fake bridge + PTY.
 */

import { act, render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub widgets that would require a live host bridge or heavy deps. The
// stubs are inlined via vi.mock so the real modules never load; without this,
// mounting TerminalPage inside jsdom tries to initialize the terminal surface.
vi.mock('../../../widgets/terminal-shell/index.js', () => ({
  TerminalShell: () => <div data-testid="terminal-shell-stub">shell</div>,
}));
vi.mock('../../../widgets/command-palette/index.js', () => ({
  CommandPalette: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="palette" /> : null,
}));

import { TerminalPage } from '../TerminalPage.js';
import { useSessionStore } from '../../../entities/session/index.js';
import { useBannerStore } from '../../../entities/banner/index.js';

describe('<TerminalPage />', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    useBannerStore.getState().resetAll();
  });

  it('renders <LoadingState /> while booting with no session id', () => {
    // reset() leaves health='booting', id=null — the initial paint.
    render(<TerminalPage />);
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
  });

  it('renders <ErrorState /> with retry when health=error and no session id', () => {
    act(() => {
      useSessionStore.getState().setSession({ health: 'error' });
    });
    render(<TerminalPage />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => /failed to start/iu.test(a.textContent ?? ''))).toBe(true);
    expect(screen.getByRole('button', { name: /try again/iu })).toBeInTheDocument();
  });

  it('ErrorState retry resets the session to booting', () => {
    act(() => {
      useSessionStore.getState().setSession({ health: 'error' });
    });
    render(<TerminalPage />);
    const retry = screen.getByRole('button', { name: /try again/iu });
    act(() => {
      fireEvent.click(retry);
    });
    expect(useSessionStore.getState().health).toBe('booting');
    // After retry, the page should now render the LoadingState.
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
  });

  it('renders <TerminalShell /> when a session id is present', () => {
    act(() => {
      useSessionStore.getState().setSession({
        id: 'sess-1',
        shell: '/bin/zsh',
        cwd: '/tmp',
        health: 'ready',
      });
    });
    render(<TerminalPage />);
    expect(screen.getByTestId('terminal-shell-stub')).toBeInTheDocument();
  });

  it('Escape dismisses the top banner when no palette is open', () => {
    // Raise a shell_integration banner, then press Escape. It should end up
    // dismissed (per the Escape cascade added to the page).
    act(() => {
      useBannerStore.getState().raise('shell_integration');
    });
    render(<TerminalPage />);
    // Escape fires on window; the keymap module listens globally.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    const bs = useBannerStore.getState();
    expect(bs.dismissed.has('shell_integration')).toBe(true);
  });
});
