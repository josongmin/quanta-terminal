/**
 * SessionTabs — widget-level tests (Phase 4).
 *
 * Exercises the presentation surface against the multi-session collection store:
 *   - An empty collection renders a single disabled fallback chip.
 *   - One session → one tab, shell basename visible, aria-selected=true.
 *   - Two sessions → two tabs, only the active one has aria-selected=true.
 *   - Click on a tab calls `onSelect` with the session id.
 *   - The `×` button calls `onClose` without also triggering `onSelect`.
 *   - The `+` button calls `onCreate`.
 *   - Delete/Backspace on a focused tab calls `onClose`.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '../../../entities/session/index.js';
import { SessionTabs } from '../SessionTabs.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

beforeEach(() => {
  useSessionsStore.getState().reset();
});

describe('<SessionTabs />', () => {
  it('renders a disabled fallback tab when the collection is empty', () => {
    render(<SessionTabs />);
    const tab = screen.getByRole('tab');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toBeDisabled();
  });

  it('renders one tab per session with shell basename visible', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      cwd: '/tmp',
      health: 'ready',
    });
    render(<SessionTabs />);
    const tab = screen.getByTestId('session-tab-sess-1');
    expect(tab).toBeEnabled();
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveTextContent(/zsh/);
  });

  it('marks only the active session as selected when multiple exist', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: 'a' as SessionId, shell: '/bin/zsh', health: 'ready' });
    coll.addSession({ id: 'b' as SessionId, shell: '/bin/bash', health: 'ready' });
    coll.setActive('b' as SessionId);
    render(<SessionTabs />);
    expect(screen.getByTestId('session-tab-a')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('session-tab-b')).toHaveAttribute('aria-selected', 'true');
  });

  it('fires onSelect with the session id on tab click', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    const onSelect = vi.fn();
    render(<SessionTabs onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('session-tab-sess-1'));
    expect(onSelect).toHaveBeenCalledWith('sess-1');
  });

  it('fires onClose (not onSelect) when the × button is clicked', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<SessionTabs onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('session-tab-close-sess-1'));
    expect(onClose).toHaveBeenCalledWith('sess-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('fires onCreate when the + button is clicked', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    const onCreate = vi.fn();
    render(<SessionTabs onCreate={onCreate} />);
    fireEvent.click(screen.getByTestId('session-tab-new'));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('closes the focused tab on Delete key', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    const onClose = vi.fn();
    render(<SessionTabs onClose={onClose} />);
    const tab = screen.getByTestId('session-tab-sess-1');
    fireEvent.keyDown(tab, { key: 'Delete' });
    expect(onClose).toHaveBeenCalledWith('sess-1');
  });

  it('closes the focused tab on Backspace key', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    const onClose = vi.fn();
    render(<SessionTabs onClose={onClose} />);
    const tab = screen.getByTestId('session-tab-sess-1');
    fireEvent.keyDown(tab, { key: 'Backspace' });
    expect(onClose).toHaveBeenCalledWith('sess-1');
  });
});
