/**
 * LiveRegion integration tests.
 *
 * Cover the policy surface end-to-end (hook + DOM):
 *   - feature off → aria-live="off", empty text.
 *   - feature on + output → the region updates after the debounce.
 *   - text clears 500 ms later so a repeat message re-announces.
 *   - TUI / alt-screen suppresses announcement.
 *   - password prompt suppresses announcement.
 *   - keymap cycle mutates the politeness attribute on the region.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useBlockStore } from '../../../entities/block/index.js';
import { useTuiStore } from '../../../entities/tui/index.js';
import { LiveRegion, LIVE_REGION_CLEAR_MS } from '../LiveRegion.js';
import {
  ANNOUNCE_DEBOUNCE_MS,
  DEFAULT_A11Y_ANNOUNCE_SETTINGS,
  useA11yAnnounceSettings,
} from '../index.js';

function resetTui() {
  useTuiStore.setState({
    active: false,
    depth: 0,
    crashed: null,
    transitioning: false,
    enteredAt: null,
    command: '',
    sessionId: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useBlockStore.getState().resetAll();
  resetTui();
  useA11yAnnounceSettings.setState({ ...DEFAULT_A11Y_ANNOUNCE_SETTINGS });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function writeToActiveBlock(text: string): string {
  const id = useBlockStore.getState().startBlock('cmd', '/');
  const chunk = new TextEncoder().encode(text);
  useBlockStore.getState().appendBlockOutput(id, chunk);
  return id;
}

describe('<LiveRegion />', () => {
  it('renders aria-live="off" when feature is disabled', () => {
    render(<LiveRegion />);
    const node = screen.getByTestId('a11y-output-announcer');
    expect(node.getAttribute('aria-live')).toBe('off');
    expect(node.textContent).toBe('');
  });

  it('applies clip-path:inset(50%) and white-space:nowrap for modern visually-hidden pattern (WCAG Bug 2)', () => {
    render(<LiveRegion />);
    const node = screen.getByTestId('a11y-output-announcer');
    // The HIDDEN_STYLE constant uses clipPath (camelCase) → rendered as clip-path by React.
    expect(node.style.clipPath).toBe('inset(50%)');
    expect(node.style.whiteSpace).toBe('nowrap');
  });

  it('updates aria-live when the settings mode changes', () => {
    render(<LiveRegion />);
    act(() => {
      useA11yAnnounceSettings.getState().setMode('polite');
    });
    expect(screen.getByTestId('a11y-output-announcer').getAttribute('aria-live')).toBe('polite');
    act(() => {
      useA11yAnnounceSettings.getState().setMode('assertive');
    });
    expect(screen.getByTestId('a11y-output-announcer').getAttribute('aria-live')).toBe(
      'assertive',
    );
  });

  it('announces a new line after the debounce window', async () => {
    useA11yAnnounceSettings.getState().setMode('polite');
    render(<LiveRegion />);
    act(() => {
      writeToActiveBlock('hello world\n');
    });
    // Still inside debounce — no text yet.
    expect(screen.getByTestId('a11y-output-announcer').textContent).toBe('');
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 5);
    });
    expect(screen.getByTestId('a11y-output-announcer').textContent).toContain('hello world');
  });

  it('clears its text after LIVE_REGION_CLEAR_MS so repeats re-announce', () => {
    useA11yAnnounceSettings.getState().setMode('polite');
    render(<LiveRegion />);
    act(() => {
      writeToActiveBlock('line-1\n');
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 5);
    });
    expect(screen.getByTestId('a11y-output-announcer').textContent).toContain('line-1');
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_CLEAR_MS + 5);
    });
    expect(screen.getByTestId('a11y-output-announcer').textContent).toBe('');
  });

  it('suppresses announcements while alt-screen / TUI is active', () => {
    useA11yAnnounceSettings.getState().setMode('polite');
    act(() => {
      useTuiStore.setState({ active: true, depth: 1 });
    });
    render(<LiveRegion />);
    act(() => {
      writeToActiveBlock('should-not-announce\n');
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 500);
    });
    expect(screen.getByTestId('a11y-output-announcer').textContent).toBe('');
  });

  it('suppresses announcements when a password prompt is the latest signal', () => {
    useA11yAnnounceSettings.getState().setMode('polite');
    render(<LiveRegion />);
    act(() => {
      writeToActiveBlock('[sudo] password for alice: ');
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 500);
    });
    // The prompt itself must not be echoed into the live region.
    expect(screen.getByTestId('a11y-output-announcer').textContent).toBe('');
  });

  it('cycleMode shortcut action cycles the exposed aria-live attribute', () => {
    render(<LiveRegion />);
    // Start: disabled → off.
    expect(screen.getByTestId('a11y-output-announcer').getAttribute('aria-live')).toBe('off');
    act(() => {
      useA11yAnnounceSettings.getState().cycleMode();
    });
    expect(screen.getByTestId('a11y-output-announcer').getAttribute('aria-live')).toBe('polite');
    act(() => {
      useA11yAnnounceSettings.getState().cycleMode();
    });
    expect(screen.getByTestId('a11y-output-announcer').getAttribute('aria-live')).toBe(
      'assertive',
    );
    act(() => {
      useA11yAnnounceSettings.getState().cycleMode();
    });
    expect(screen.getByTestId('a11y-output-announcer').getAttribute('aria-live')).toBe('off');
  });
});
