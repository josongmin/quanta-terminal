/**
 * BellFlash integration test — asserts the overlay appears and disappears
 * in response to bell store changes, and that it honours the visualBell
 * setting and prefers-reduced-motion.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BellFlash } from '../BellFlash.js';
import { useBellStore } from '../../../entities/bell/index.js';
import { useBellSettings } from '../../../features/bell/index.js';

describe('BellFlash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useBellStore.getState().reset();
    useBellSettings.setState({ visualBell: true, audibleBell: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing before any bell', () => {
    const { container } = render(<BellFlash />);
    expect(container.querySelector('[data-testid="bell-flash"]')).toBeNull();
  });

  it('mounts the flash element when bellCount advances', () => {
    render(<BellFlash />);
    act(() => {
      useBellStore.getState().trigger(Date.now());
    });
    const el = screen.getByTestId('bell-flash');
    expect(el).toBeTruthy();
    expect(el.getAttribute('data-bell-seq')).toBe('1');
  });

  it('removes the flash element after the flash duration', () => {
    render(<BellFlash />);
    act(() => {
      useBellStore.getState().trigger(Date.now());
    });
    expect(screen.queryByTestId('bell-flash')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.queryByTestId('bell-flash')).toBeNull();
  });

  it('renders nothing when visualBell is disabled', () => {
    useBellSettings.setState({ visualBell: false, audibleBell: false });
    render(<BellFlash />);
    act(() => {
      useBellStore.getState().trigger(Date.now());
    });
    expect(screen.queryByTestId('bell-flash')).toBeNull();
  });

  it('reflects prefers-reduced-motion in a data attribute so CSS can respond', () => {
    // Force the matchMedia mock to report reduced motion.
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q.includes('reduce'),
        media: q,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    try {
      render(<BellFlash />);
      act(() => {
        useBellStore.getState().trigger(Date.now());
      });
      const el = screen.getByTestId('bell-flash');
      expect(el.getAttribute('data-reduced-motion')).toBe('true');
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});
