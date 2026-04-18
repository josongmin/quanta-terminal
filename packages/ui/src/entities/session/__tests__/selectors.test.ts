/**
 * Selector shape tests.
 *
 * The critical property: changing a field NOT in the slice must not trigger a
 * new selector result (same reference). This guarantees that a widget using
 * `useShallow` will not re-render when unrelated store fields change.
 *
 * Also asserts that the bare `subscribe` subscription only fires on change
 * (per-field) — the `subscribeWithSelector` middleware's second-form call with
 * a selector + equality function.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionStore, useStatusBarSelector } from '../index.js';

describe('session selectors (subscribeWithSelector + useShallow)', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('useStatusBarSelector does not change reference when an unrelated field changes', () => {
    const { result, rerender } = renderHook(() => useStatusBarSelector());
    const first = result.current;
    // cwdSource is NOT part of the StatusBarSlice.
    useSessionStore.getState().setSession({ cwdSource: 'osc7' });
    rerender();
    expect(result.current).toBe(first);
  });

  it('useStatusBarSelector yields a new reference when a slice field changes', () => {
    const { result, rerender } = renderHook(() => useStatusBarSelector());
    const first = result.current;
    useSessionStore.getState().setSession({ shell: '/bin/zsh' });
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.shell).toBe('/bin/zsh');
  });

  it('subscribeWithSelector only invokes the listener when the selected slice changes', () => {
    const listener = vi.fn();
    // Second-form subscribe: selector + equality. Requires the
    // subscribeWithSelector middleware to be in place.
    const unsubscribe = useSessionStore.subscribe(
      (s) => s.shell,
      (next, prev) => listener(next, prev),
    );
    useSessionStore.getState().setSession({ cwd: '/tmp' });
    expect(listener).not.toHaveBeenCalled();
    useSessionStore.getState().setSession({ shell: '/bin/fish' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    useSessionStore.getState().setSession({ shell: '/bin/bash' });
    // After unsubscribe, no further calls.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('store is not persisted to any storage', () => {
    // The brief explicitly bans accidental localStorage persistence.
    // zustand's persist middleware writes to localStorage synchronously on set;
    // if it were wired, keys would appear after a mutation.
    const before = new Set(Object.keys(globalThis.localStorage ?? {}));
    useSessionStore.getState().setSession({ shell: '/bin/zsh' });
    const after = new Set(Object.keys(globalThis.localStorage ?? {}));
    expect(after).toEqual(before);
  });
});
