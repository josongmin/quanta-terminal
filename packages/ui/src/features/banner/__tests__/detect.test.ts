import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { useBannerStore } from '../../../entities/banner/index.js';
import { installBannerDetectors } from '../detect.js';

let handle: { unsubscribe: () => void } | null = null;

beforeEach(() => {
  useSessionStore.getState().reset();
  useBannerStore.getState().resetAll();
});

afterEach(() => {
  if (handle) handle.unsubscribe();
  handle = null;
});

describe('installBannerDetectors', () => {
  it('raises shell_integration when shellIntegration is missing', () => {
    handle = installBannerDetectors();
    // reset() puts us in shellIntegration='missing' by default, so
    // evaluate should have already raised the condition.
    expect(useBannerStore.getState().active.has('shell_integration')).toBe(true);
  });

  it('clears shell_integration when the status flips to installed', () => {
    handle = installBannerDetectors();
    useSessionStore.getState().setSession({ shellIntegration: 'installed' });
    expect(useBannerStore.getState().active.has('shell_integration')).toBe(false);
  });

  it('raises crash when health becomes error', () => {
    handle = installBannerDetectors();
    useSessionStore.getState().setSession({ health: 'error' });
    expect(useBannerStore.getState().active.has('crash')).toBe(true);
  });

  it('raises crash on POSIX signal exit code', () => {
    handle = installBannerDetectors();
    useSessionStore.getState().markExited(139); // SIGSEGV
    expect(useBannerStore.getState().active.has('crash')).toBe(true);
  });

  it('does not raise crash for clean exit', () => {
    handle = installBannerDetectors();
    useSessionStore.getState().markExited(0);
    expect(useBannerStore.getState().active.has('crash')).toBe(false);
  });
});
