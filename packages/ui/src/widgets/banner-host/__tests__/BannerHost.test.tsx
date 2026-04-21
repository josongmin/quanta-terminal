import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBannerStore } from '../../../entities/banner/index.js';
import { raiseSyntheticBanner, clearSyntheticBanner } from '../../../features/banner/index.js';
import { BannerHost } from '../BannerHost.js';
import { getFeatureFlag } from '../../../shared/config/feature-flags.js';

/**
 * Plan 0005 Epic δ: the `shell_integration` banner is a block-UX affordance
 * (it nags the user to install the OSC 133 integration script so block
 * boundaries work). When `flag.blockUx` is off the production `BannerHost`
 * filters shell_integration out of the visible list (see `BannerHost.tsx`
 * line 94), so the tests below that assert shell_integration rendering are
 * P1-gated. Other banners (crash/quota/secret_rescan) surface in P0 too
 * and their tests run unconditionally.
 */
const itP1 = getFeatureFlag('blockUx') ? it : it.skip;

beforeEach(() => {
  useBannerStore.getState().resetAll();
});

describe('<BannerHost />', () => {
  it('renders nothing when no conditions are active', () => {
    render(<BannerHost />);
    expect(screen.queryByTestId('banner-host')).toBeNull();
  });

  itP1('renders the shell_integration banner copy when the condition is active [P1 blockUx]', () => {
    act(() => {
      raiseSyntheticBanner('shell_integration');
    });
    render(<BannerHost />);
    expect(screen.getByTestId('banner-host')).toBeInTheDocument();
    expect(screen.getByText(/shell integration is not installed/iu)).toBeInTheDocument();
  });

  it('renders only the highest-precedence banner when multiple are active', () => {
    act(() => {
      raiseSyntheticBanner('shell_integration');
      raiseSyntheticBanner('quota');
      raiseSyntheticBanner('crash');
    });
    render(<BannerHost />);
    expect(screen.getByText(/shell exited unexpectedly/iu)).toBeInTheDocument();
    expect(screen.queryByText(/shell integration is not installed/iu)).toBeNull();
    expect(screen.queryByText(/history storage/iu)).toBeNull();
  });

  it('announces crash as alert (role=alert)', () => {
    act(() => {
      raiseSyntheticBanner('crash');
    });
    render(<BannerHost />);
    const host = screen.getByTestId('banner-host');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('announces shell_integration politely (role=status)', () => {
    act(() => {
      raiseSyntheticBanner('shell_integration');
    });
    render(<BannerHost />);
    const host = screen.getByTestId('banner-host');
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });

  it('suppresses the slide animation under prefers-reduced-motion', () => {
    // The MQ is expressed in CSS (prefers-reduced-motion: reduce). We can't
    // exercise the actual keyframe run in jsdom, but we CAN assert the host
    // honors the MQ by exposing a class CSS can scope on. The CSS module
    // suppresses `.slide` animation when the MQ matches — we pin the slide
    // class existence here so the MQ selector keeps matching the right node.
    act(() => {
      raiseSyntheticBanner('shell_integration');
    });
    render(<BannerHost />);
    const host = screen.getByTestId('banner-host');
    // There must be a node with the `.slide` class as a direct child — the
    // CSS `@media (prefers-reduced-motion: reduce) { .slide { animation: none }}`
    // depends on this name.
    expect(host.querySelector('[class*="slide"]')).not.toBeNull();
  });

  it('dismiss removes the banner until another condition rises', () => {
    act(() => {
      raiseSyntheticBanner('shell_integration');
    });
    const { rerender } = render(<BannerHost />);
    const dismissBtn = screen.getByRole('button', { name: /not now/iu });
    act(() => {
      dismissBtn.click();
    });
    rerender(<BannerHost />);
    expect(screen.queryByTestId('banner-host')).toBeNull();
    // A new condition (crash) breaks through.
    act(() => {
      raiseSyntheticBanner('crash');
    });
    rerender(<BannerHost />);
    expect(screen.getByText(/shell exited unexpectedly/iu)).toBeInTheDocument();
    // cleanup for subsequent assertions
    act(() => {
      clearSyntheticBanner('crash');
    });
  });
});
