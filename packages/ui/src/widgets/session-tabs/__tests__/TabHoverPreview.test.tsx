/**
 * TabHoverPreview — dwell/cancel behavior and content correctness.
 *
 * The preview card is a portal-rendered decorative surface that appears
 * after a 600ms hover over an inactive tab. We exercise:
 *
 *   - Timing: 300ms hover → nothing mounted; 700ms → mounted.
 *   - Cancel: mouse leave before the timer fires → nothing ever mounts.
 *   - Click: clicking a tab during the dwell → preview dismissed and
 *     `onSelect` fires (click-through still switches tabs instantly).
 *   - Content: the card carries the hovered session's cwd and the tail
 *     lines of that session's most recent block output.
 *   - a11y: the card is `aria-hidden="true"` so it stays invisible to AT.
 *   - Active tab: hovering the active tab never mounts the preview —
 *     the user is already looking at that session.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '../../../entities/session/index.js';
import { useBlockStore } from '../../../entities/block/index.js';
import { SessionTabs } from '../SessionTabs.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

function seedTwoSessions() {
  const coll = useSessionsStore.getState();
  coll.addSession({
    id: 'a' as SessionId,
    shell: '/bin/zsh',
    cwd: '/Users/demo/projects/alpha',
    health: 'ready',
  });
  coll.addSession({
    id: 'b' as SessionId,
    shell: '/bin/bash',
    cwd: '/Users/demo/projects/beta',
    health: 'ready',
  });
  // `a` is active (first added), so `b` is the inactive tab we preview.
  coll.setActive('a' as SessionId);
}

function seedBlockFor(sessionId: SessionId, text: string) {
  const id = useBlockStore
    .getState()
    .startBlock('echo', '/Users/demo/projects/beta', { sessionId });
  useBlockStore.getState().appendBlockOutput(id, new TextEncoder().encode(text));
  return id;
}

beforeEach(() => {
  vi.useFakeTimers();
  useSessionsStore.getState().reset();
  useBlockStore.getState().resetAll();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('TabHoverPreview — dwell timing', () => {
  it('does not mount the preview after a 300ms hover', () => {
    seedTwoSessions();
    render(<SessionTabs />);
    const tabB = screen.getByTestId('session-tab-b');
    act(() => {
      fireEvent.mouseEnter(tabB);
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId('session-tab-preview-b')).toBeNull();
    // Leave so the pending timer is cleared cleanly before the test ends —
    // otherwise the afterEach timer flush can fire our setTimeout against a
    // component unmount-in-flight and trip React's act() warning.
    act(() => {
      fireEvent.mouseLeave(tabB);
    });
  });

  it('mounts the preview after a 700ms hover', () => {
    seedTwoSessions();
    render(<SessionTabs />);
    const tabB = screen.getByTestId('session-tab-b');
    act(() => {
      fireEvent.mouseEnter(tabB);
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByTestId('session-tab-preview-b')).toBeInTheDocument();
  });

  it('mouse leave during the dwell cancels the pending preview', () => {
    seedTwoSessions();
    render(<SessionTabs />);
    const tabB = screen.getByTestId('session-tab-b');
    act(() => {
      fireEvent.mouseEnter(tabB);
      vi.advanceTimersByTime(300);
      fireEvent.mouseLeave(tabB);
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId('session-tab-preview-b')).toBeNull();
  });

  it('click on a hovered tab cancels any pending preview and switches tabs', () => {
    seedTwoSessions();
    const onSelect = vi.fn();
    render(<SessionTabs onSelect={onSelect} />);
    const tabB = screen.getByTestId('session-tab-b');
    act(() => {
      fireEvent.mouseEnter(tabB);
      vi.advanceTimersByTime(300);
      fireEvent.click(tabB);
    });
    expect(onSelect).toHaveBeenCalledWith('b');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId('session-tab-preview-b')).toBeNull();
  });

  it('keyboard interaction on a hovered tab dismisses the preview', () => {
    seedTwoSessions();
    render(<SessionTabs />);
    const tabB = screen.getByTestId('session-tab-b');
    act(() => {
      fireEvent.mouseEnter(tabB);
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByTestId('session-tab-preview-b')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(tabB, { key: 'ArrowRight' });
    });
    expect(screen.queryByTestId('session-tab-preview-b')).toBeNull();
  });

  it('does not mount a preview for the currently active tab', () => {
    seedTwoSessions();
    render(<SessionTabs />);
    const tabA = screen.getByTestId('session-tab-a');
    act(() => {
      fireEvent.mouseEnter(tabA);
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId('session-tab-preview-a')).toBeNull();
  });
});

describe('TabHoverPreview — content', () => {
  it('renders the hovered session cwd and output tail', () => {
    seedTwoSessions();
    seedBlockFor('b' as SessionId, 'line 1\nline 2\nline 3\nfinal line\n');
    render(<SessionTabs />);
    const tabB = screen.getByTestId('session-tab-b');
    act(() => {
      fireEvent.mouseEnter(tabB);
      vi.advanceTimersByTime(700);
    });
    const preview = screen.getByTestId('session-tab-preview-b');
    expect(preview).toBeInTheDocument();
    // cwd segment rendered (we allow ellipsis/abbreviation — just make sure
    // the distinctive tail directory "beta" is visible).
    expect(preview.textContent ?? '').toContain('beta');
    // Final output line should be part of the preview body.
    const body = screen.getByTestId('session-tab-preview-body-b');
    expect(body.textContent ?? '').toContain('final line');
  });

  it('shows the (no output) placeholder when the hovered session has no blocks', () => {
    seedTwoSessions();
    render(<SessionTabs />);
    const tabB = screen.getByTestId('session-tab-b');
    act(() => {
      fireEvent.mouseEnter(tabB);
      vi.advanceTimersByTime(700);
    });
    const body = screen.getByTestId('session-tab-preview-body-b');
    expect(body.textContent ?? '').toContain('(no output)');
  });

  it('marks the preview card aria-hidden (purely decorative)', () => {
    seedTwoSessions();
    render(<SessionTabs />);
    const tabB = screen.getByTestId('session-tab-b');
    act(() => {
      fireEvent.mouseEnter(tabB);
      vi.advanceTimersByTime(700);
    });
    const preview = screen.getByTestId('session-tab-preview-b');
    expect(preview).toHaveAttribute('aria-hidden', 'true');
  });
});
