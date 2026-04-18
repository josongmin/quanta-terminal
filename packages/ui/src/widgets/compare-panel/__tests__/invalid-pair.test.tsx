/**
 * ComparePanel — defensive invalid-pair path.
 *
 * `openCompare(leftId, rightId)` in the compare store is followed by
 * `<ComparePanel />` reading both blocks. If either id vanishes between the
 * dispatcher's presence check and the render (e.g. clearHistory mid-animation),
 * the panel renders `ComparePanelInvalid`, which calls `onClose` and returns
 * null.
 *
 * Regression: the effect used to depend on the entire `props` object, which
 * mints a fresh identity on every render. Under React 18 StrictMode that
 * caused an update loop where `closeCompare` was invoked continuously. The
 * fix destructures `onClose` out of props and depends on the destructured
 * handler (stable because Zustand actions are referentially stable).
 */

import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { useCompareStore } from '../../../entities/compare/index.js';
import { ComparePanel } from '../ComparePanel.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useCompareStore.getState().resetAll();
});

afterEach(() => {
  useCompareStore.getState().resetAll();
});

describe('<ComparePanel /> invalid-pair defensive close', () => {
  it('closes itself when the right block id points at a missing entity', () => {
    const leftId = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(leftId, 0);
    // Open with a right id that doesn't exist in the store.
    act(() => {
      useCompareStore.getState().openCompare({
        leftId,
        rightId: 'missing-right-id',
      });
    });
    // Render the panel. The mounted invalid-path effect fires `closeCompare`,
    // which flips `open` back to false; a second render cycle then yields null.
    act(() => {
      render(<ComparePanel />);
    });
    // `closeCompare` keeps the pair around (see entities/compare/model.ts);
    // we assert only the `open` flag because that's what gates the render.
    expect(useCompareStore.getState().open).toBe(false);
  });

  it('does not loop: a stable effect dep settles within one tick', () => {
    const leftId = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(leftId, 0);
    act(() => {
      useCompareStore.getState().openCompare({
        leftId,
        rightId: 'missing',
      });
    });
    const beforeOpen = useCompareStore.getState().open;
    expect(beforeOpen).toBe(true);
    // Render twice to simulate StrictMode double-invocation; the effect
    // must converge without thrashing the compare state.
    const { rerender } = render(<ComparePanel />);
    rerender(<ComparePanel />);
    expect(useCompareStore.getState().open).toBe(false);
  });
});
