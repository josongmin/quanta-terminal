import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBannerStore } from '../../../entities/banner/index.js';
import {
  raiseSyntheticBanner,
  clearSyntheticBanner,
} from '../../../features/banner/index.js';
import { BannerHost } from '../BannerHost.js';

beforeEach(() => {
  useBannerStore.getState().resetAll();
});

describe('<BannerHost />', () => {
  it('renders nothing when no conditions are active', () => {
    render(<BannerHost />);
    expect(screen.queryByTestId('banner-host')).toBeNull();
  });

  it('renders the shell_integration banner copy when the condition is active', () => {
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
