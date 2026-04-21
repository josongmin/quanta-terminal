/**
 * Plan 0005 P1-C polish — EvictionBanner spec.
 *
 * The banner's contract:
 *
 *   - Does NOT render when `pinBlockedEvictions === 0` and
 *     `pinnedRowCount === 0` on first mount.
 *   - Renders when `pinBlockedEvictions` bumps.
 *   - Auto-dismisses after a cooldown when pin is cleared.
 *   - Re-renders on a subsequent burst after user dismissed.
 *   - Survives the dismiss button (fires onClick and hides).
 *   - Cleans up its cooldown timer on unmount (no throws, no leaks).
 */

import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EvictionBanner, formatFreeableBytes } from '../EvictionBanner.js';

afterEach(() => cleanup());

/**
 * Simple fake scheduler shared by the timer-driven tests. Calls fire
 * synchronously in FIFO order when `fire()` is invoked.
 */
function makeFakeScheduler(): {
  schedule: (cb: () => void, ms: number) => unknown;
  cancel: (h: unknown) => void;
  fire: () => void;
  pending: () => number;
} {
  const queue: Array<{ cb: () => void; cancelled: boolean }> = [];
  return {
    schedule: (cb) => {
      const entry = { cb, cancelled: false };
      queue.push(entry);
      return entry;
    },
    cancel: (h) => {
      const entry = h as { cancelled: boolean } | undefined;
      if (entry) entry.cancelled = true;
    },
    fire: () => {
      while (queue.length > 0) {
        const head = queue.shift();
        if (!head || head.cancelled) continue;
        head.cb();
        return;
      }
    },
    pending: () => queue.filter((e) => !e.cancelled).length,
  };
}

describe('EvictionBanner', () => {
  it('does not render on first mount with zero counters', () => {
    render(
      <EvictionBanner
        pinBlockedEvictions={0}
        pinnedRowCount={0}
        freeableBytes={0}
      />,
    );
    expect(screen.queryByTestId('eviction-banner')).toBeNull();
  });

  it('renders when pinBlockedEvictions is non-zero on mount', () => {
    render(
      <EvictionBanner
        pinBlockedEvictions={0}
        pinnedRowCount={0}
        freeableBytes={0}
      />,
    );
    // Re-render with counter > 0 via a new render (simulating the host feeding
    // live emulator state on the next tick).
    cleanup();
    render(
      <EvictionBanner
        pinBlockedEvictions={3}
        pinnedRowCount={5}
        freeableBytes={5 * 80 * 48}
      />,
    );
    expect(screen.getByTestId('eviction-banner')).toBeInTheDocument();
    expect(screen.getByTestId('eviction-banner-label')).toHaveTextContent(
      /oldest 5 rows pinned/,
    );
    expect(screen.getByTestId('eviction-banner-label')).toHaveTextContent(/free/);
  });

  it('transitions from armed → cooling after pinnedRowCount goes to 0', () => {
    const fake = makeFakeScheduler();
    const { rerender } = render(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={3}
        freeableBytes={1024}
        scheduler={fake.schedule}
        cancelScheduler={fake.cancel}
        cooldownMs={10}
      />,
    );
    // Armed phase: banner visible.
    expect(
      screen.getByTestId('eviction-banner').getAttribute('data-phase'),
    ).toBe('armed');
    // Pin released.
    rerender(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={0}
        freeableBytes={0}
        scheduler={fake.schedule}
        cancelScheduler={fake.cancel}
        cooldownMs={10}
      />,
    );
    expect(
      screen.getByTestId('eviction-banner').getAttribute('data-phase'),
    ).toBe('cooling');
    // Fire the cooldown timer (wrap in act so the setPhase flushes).
    act(() => {
      fake.fire();
    });
    rerender(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={0}
        freeableBytes={0}
        scheduler={fake.schedule}
        cancelScheduler={fake.cancel}
        cooldownMs={10}
      />,
    );
    expect(screen.queryByTestId('eviction-banner')).toBeNull();
  });

  it('dismisses via the dismiss button', () => {
    render(
      <EvictionBanner
        pinBlockedEvictions={2}
        pinnedRowCount={1}
        freeableBytes={2048}
      />,
    );
    expect(screen.getByTestId('eviction-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('eviction-banner-dismiss'));
    expect(screen.queryByTestId('eviction-banner')).toBeNull();
  });

  it('re-arms on a NEW burst after user dismissal', () => {
    const { rerender } = render(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={1}
        freeableBytes={512}
      />,
    );
    // Dismiss the banner.
    fireEvent.click(screen.getByTestId('eviction-banner-dismiss'));
    expect(screen.queryByTestId('eviction-banner')).toBeNull();

    // Later: counter bumps to a new higher value — banner should reappear.
    rerender(
      <EvictionBanner
        pinBlockedEvictions={2}
        pinnedRowCount={2}
        freeableBytes={1024}
      />,
    );
    expect(screen.getByTestId('eviction-banner')).toBeInTheDocument();
  });

  it('stays dismissed when counter stays flat after dismiss', () => {
    const { rerender } = render(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={1}
        freeableBytes={512}
      />,
    );
    fireEvent.click(screen.getByTestId('eviction-banner-dismiss'));
    rerender(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={1}
        freeableBytes={512}
      />,
    );
    expect(screen.queryByTestId('eviction-banner')).toBeNull();
  });

  it('renders singular "row" label when pinnedRowCount === 1', () => {
    render(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={1}
        freeableBytes={1024}
      />,
    );
    expect(screen.getByTestId('eviction-banner-label')).toHaveTextContent(
      /oldest 1 row pinned/,
    );
  });

  it('omits the "will free" clause when freeableBytes is zero', () => {
    render(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={1}
        freeableBytes={0}
      />,
    );
    expect(
      screen.getByTestId('eviction-banner-label').textContent,
    ).not.toMatch(/free/);
  });

  it('cancels its cooldown timer on unmount', () => {
    const fake = makeFakeScheduler();
    const { rerender, unmount } = render(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={2}
        freeableBytes={1024}
        scheduler={fake.schedule}
        cancelScheduler={fake.cancel}
        cooldownMs={100}
      />,
    );
    // Trigger cooling.
    rerender(
      <EvictionBanner
        pinBlockedEvictions={1}
        pinnedRowCount={0}
        freeableBytes={0}
        scheduler={fake.schedule}
        cancelScheduler={fake.cancel}
        cooldownMs={100}
      />,
    );
    expect(fake.pending()).toBeGreaterThanOrEqual(1);
    unmount();
    // The entry should be cancelled; firing is safe no-op.
    expect(() => fake.fire()).not.toThrow();
  });
});

describe('formatFreeableBytes', () => {
  it('formats megabytes with one decimal', () => {
    expect(formatFreeableBytes(3.2 * 1024 * 1024)).toBe('3.2 MB');
  });
  it('formats kilobytes rounded', () => {
    // JS Math.round rounds .5 AWAY from zero for positives: 2.5 → 3.
    expect(formatFreeableBytes(2560)).toBe('3 KB');
    expect(formatFreeableBytes(1024 * 3.6)).toBe('4 KB');
    expect(formatFreeableBytes(1024 * 2.2)).toBe('2 KB');
  });
  it('formats bytes below 1 KB', () => {
    expect(formatFreeableBytes(800)).toBe('800 B');
  });
  it('returns empty string for non-positive / NaN', () => {
    expect(formatFreeableBytes(0)).toBe('');
    expect(formatFreeableBytes(-5)).toBe('');
    expect(formatFreeableBytes(Number.NaN)).toBe('');
  });
});
