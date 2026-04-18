import { beforeEach, describe, expect, it } from 'vitest';
import { useBannerStore, selectVisibleConditions } from '../model.js';

beforeEach(() => {
  useBannerStore.getState().resetAll();
});

describe('banner store', () => {
  it('raise adds to active set', () => {
    useBannerStore.getState().raise('crash');
    expect(useBannerStore.getState().active.has('crash')).toBe(true);
  });

  it('raise is idempotent (same reference not guaranteed, but size stable)', () => {
    useBannerStore.getState().raise('crash');
    useBannerStore.getState().raise('crash');
    expect(useBannerStore.getState().active.size).toBe(1);
  });

  it('clear removes from active set', () => {
    useBannerStore.getState().raise('quota');
    useBannerStore.getState().clear('quota');
    expect(useBannerStore.getState().active.has('quota')).toBe(false);
  });

  it('dismiss keeps the condition active but hides it from the visible selector', () => {
    const s = useBannerStore.getState();
    s.raise('shell_integration');
    s.dismiss('shell_integration');
    expect(useBannerStore.getState().active.has('shell_integration')).toBe(true);
    expect(useBannerStore.getState().dismissed.has('shell_integration')).toBe(true);
    expect(selectVisibleConditions(useBannerStore.getState())).toEqual([]);
  });

  it('selectVisibleConditions surfaces only non-dismissed active conditions', () => {
    const s = useBannerStore.getState();
    s.raise('crash');
    s.raise('quota');
    s.dismiss('quota');
    const visible = selectVisibleConditions(useBannerStore.getState());
    expect(visible).toContain('crash');
    expect(visible).not.toContain('quota');
  });
});
