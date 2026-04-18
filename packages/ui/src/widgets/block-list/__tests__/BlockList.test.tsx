/**
 * BlockList — rendering and autoscroll-rule tests.
 *
 * Virtualization in jsdom has a zero-sized layout (every element reports
 * offsetWidth/offsetHeight === 0), which makes `@tanstack/react-virtual`'s
 * range calculation return an empty set. We patch `offsetWidth/offsetHeight`
 * on HTMLElement for the lifetime of each test so the virtualizer has a
 * viewport to render into.
 *
 * With that stub in place we can exercise:
 *   - empty state content;
 *   - visible block cards when the store has blocks;
 *   - clearHistory dropping non-pinned cards;
 *   - a pure unit on the `shouldAutoscroll` helper covering the edge cases.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { BlockList, shouldAutoscroll } from '../BlockList.js';

// Stash the original descriptors so we can restore after tests run.
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

beforeEach(() => {
  useBlockStore.getState().resetAll();
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  });
});

afterEach(() => {
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
});

describe('<BlockList />', () => {
  it('renders the empty state when there are no blocks', () => {
    render(<BlockList />);
    expect(screen.getByTestId('block-list-empty')).toBeInTheDocument();
    expect(screen.getByText(/Type a command below to get started/iu)).toBeInTheDocument();
  });

  it('renders one card per block in store order', () => {
    const a = useBlockStore.getState().createBlock('alpha', '/');
    const b = useBlockStore.getState().createBlock('beta', '/');
    render(<BlockList />);
    expect(screen.getByTestId(`block-card-${a}`)).toBeInTheDocument();
    expect(screen.getByTestId(`block-card-${b}`)).toBeInTheDocument();
  });

  it('reflects clearHistory by dropping non-pinned cards', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    const b = useBlockStore.getState().createBlock('b', '/');
    useBlockStore.getState().togglePin(a);
    const { rerender } = render(<BlockList />);
    useBlockStore.getState().clearHistory();
    rerender(<BlockList />);
    expect(screen.getByTestId(`block-card-${a}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`block-card-${b}`)).toBeNull();
  });
});

describe('<BlockList /> — ResizeObserver rAF batching', () => {
  // Cache the original ResizeObserver and rAF so we can restore after each test.
  const origRO = globalThis.ResizeObserver;
  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;

  afterEach(() => {
    globalThis.ResizeObserver = origRO;
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
  });

  it('coalesces a burst of ResizeObserver callbacks into at most one frame', () => {
    // `BlockList` and `@tanstack/react-virtual` both register ResizeObservers.
    // The autoscroll observer is the one that targets the content wrapper
    // (scrollEl.firstElementChild), not the scroll element itself — we
    // discriminate by the observed node.
    type Cb = ResizeObserverCallback;
    const observers: Array<{ cb: Cb; targets: Element[] }> = [];
    class FakeRO {
      private targets: Element[] = [];
      constructor(cb: Cb) {
        // Retain the callback only via the `observers` bag. We intentionally
        // don't assign `this.cb = cb` — TS's noUnusedLocals flagged the
        // never-read field. The tests read the callback off `observers[i].cb`.
        observers.push({ cb, targets: this.targets });
      }
      observe(t: Element): void {
        this.targets.push(t);
      }
      disconnect(): void {
        this.targets.length = 0;
      }
      unobserve(t: Element): void {
        const i = this.targets.indexOf(t);
        if (i >= 0) this.targets.splice(i, 1);
      }
    }
    (globalThis as unknown as { ResizeObserver: typeof FakeRO }).ResizeObserver = FakeRO;

    const pending: Array<() => void> = [];
    (globalThis as unknown as {
      requestAnimationFrame: (cb: () => void) => number;
    }).requestAnimationFrame = (cb: () => void): number => {
      pending.push(cb);
      return pending.length;
    };
    (globalThis as unknown as {
      cancelAnimationFrame: (id: number) => void;
    }).cancelAnimationFrame = (id: number): void => {
      const idx = id - 1;
      if (idx >= 0 && idx < pending.length) pending[idx] = () => {};
    };

    useBlockStore.getState().createBlock('a', '/');
    render(<BlockList />);
    // The BlockList autoscroll observer watches the INNER (content) element.
    // Find the observer whose target's parent is the scroll root.
    const scroll = document.querySelector('[data-testid="block-list"]');
    if (!scroll) throw new Error('scroll element not found');
    const inner = scroll.firstElementChild;
    if (!inner) throw new Error('inner element not found');
    const entry = observers.find((o) => o.targets.includes(inner as Element));
    if (!entry) throw new Error('autoscroll RO not found');

    const fakeEntries = [] as unknown as ResizeObserverEntry[];
    const fakeRo = entry as unknown as ResizeObserver;
    const pendingBefore = pending.length;

    // Burst of resizes before the frame flushes.
    entry.cb(fakeEntries, fakeRo);
    entry.cb(fakeEntries, fakeRo);
    entry.cb(fakeEntries, fakeRo);
    // Only ONE rAF should have been scheduled despite three fires.
    expect(pending.length - pendingBefore).toBe(1);

    // Flush the frame — additional fires after flush can schedule again.
    pending[pending.length - 1]!();
    const pendingAfterFlush = pending.length;
    entry.cb(fakeEntries, fakeRo);
    expect(pending.length - pendingAfterFlush).toBe(1);
  });
});

describe('shouldAutoscroll', () => {
  const threshold = 64;

  it('pins to end when a new block is created even if user scrolled up', () => {
    expect(
      shouldAutoscroll({
        prevCount: 2,
        nextCount: 3,
        distanceFromBottom: 500,
        threshold,
      }),
    ).toBe(true);
  });

  it('pins when the user is near the bottom (within threshold)', () => {
    expect(
      shouldAutoscroll({
        prevCount: 2,
        nextCount: 2,
        distanceFromBottom: 32,
        threshold,
      }),
    ).toBe(true);
  });

  it('does not pin when the user has scrolled up past the threshold', () => {
    expect(
      shouldAutoscroll({
        prevCount: 2,
        nextCount: 2,
        distanceFromBottom: 200,
        threshold,
      }),
    ).toBe(false);
  });

  it('pins exactly at the threshold boundary (inclusive)', () => {
    expect(
      shouldAutoscroll({
        prevCount: 1,
        nextCount: 1,
        distanceFromBottom: threshold,
        threshold,
      }),
    ).toBe(true);
  });
});
