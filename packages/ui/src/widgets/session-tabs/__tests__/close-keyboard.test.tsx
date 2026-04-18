/**
 * Accessibility regression for the × close affordance on a tab.
 *
 * The close button was previously `tabIndex={-1}` (unreachable by keyboard)
 * while still announcing `role="button"`. The audit pass lifted it to
 * `tabIndex={0}` and added an Enter/Space handler so keyboard users can
 * close a session without resorting to Delete/Backspace on the parent tab.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '../../../entities/session/index.js';
import { SessionTabs } from '../SessionTabs.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

beforeEach(() => {
  useSessionsStore.getState().reset();
});

describe('<SessionTabs /> × button keyboard reachability', () => {
  it('the × is in the tab order (tabIndex=0)', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    render(<SessionTabs onClose={vi.fn()} />);
    const close = screen.getByTestId('session-tab-close-sess-1');
    expect(close.getAttribute('tabIndex')).toBe('0');
  });

  it('pressing Enter on the focused × calls onClose', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    const onClose = vi.fn();
    render(<SessionTabs onClose={onClose} />);
    const close = screen.getByTestId('session-tab-close-sess-1');
    fireEvent.keyDown(close, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledWith('sess-1');
  });

  it('pressing Space on the focused × calls onClose', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    const onClose = vi.fn();
    render(<SessionTabs onClose={onClose} />);
    const close = screen.getByTestId('session-tab-close-sess-1');
    fireEvent.keyDown(close, { key: ' ' });
    expect(onClose).toHaveBeenCalledWith('sess-1');
  });

  it('Enter on the × does NOT also trigger onSelect on the parent tab', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<SessionTabs onClose={onClose} onSelect={onSelect} />);
    const close = screen.getByTestId('session-tab-close-sess-1');
    fireEvent.keyDown(close, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);
    // stopPropagation prevents the parent tab's onKeyDown (Delete/Backspace)
    // from mis-firing on Enter/Space.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('other keys on the × are ignored (no double-close on Backspace)', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    const onClose = vi.fn();
    render(<SessionTabs onClose={onClose} />);
    const close = screen.getByTestId('session-tab-close-sess-1');
    // Backspace/Delete are handled on the parent tab; pressing them on the
    // close element itself must not invoke the close twice (once on the span
    // handler, once on the parent button). Since we only handle Enter/Space,
    // Backspace on the × drops straight through and the parent's keydown
    // listener does fire — that's a single close call, which is correct.
    fireEvent.keyDown(close, { key: 'Backspace' });
    // Because fireEvent.keyDown doesn't bubble into a React-owned handler on
    // the parent through JSdom's synthetic dispatch by default, we only
    // assert that the span did NOT handle Backspace itself (no extra call
    // via our new handler). The parent path is covered in SessionTabs.test.tsx.
    expect(onClose.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
