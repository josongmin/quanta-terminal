/**
 * BannerHost edge case: all four banner kinds active simultaneously.
 * Per ADR 0010 precedence: `crash > quota > secret_rescan > shell_integration`.
 * Only the top-precedence banner surfaces; the others queue silently.
 */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBannerStore } from '../../../entities/banner/index.js';
import { raiseSyntheticBanner } from '../../../features/banner/index.js';
import { BannerHost } from '../BannerHost.js';

beforeEach(() => {
  useBannerStore.getState().resetAll();
});

describe('<BannerHost /> all-four-active precedence', () => {
  it('renders only the crash banner when crash + quota + secret_rescan + shell_integration all fire', () => {
    act(() => {
      raiseSyntheticBanner('shell_integration');
      raiseSyntheticBanner('secret_rescan');
      raiseSyntheticBanner('quota');
      raiseSyntheticBanner('crash');
    });
    render(<BannerHost />);
    expect(screen.getByText(/shell exited unexpectedly/iu)).toBeInTheDocument();
    expect(screen.queryByText(/history storage/iu)).toBeNull();
    expect(screen.queryByText(/secret redaction rules/iu)).toBeNull();
    expect(screen.queryByText(/shell integration is not installed/iu)).toBeNull();
  });

  it('crash + quota: only crash visible', () => {
    act(() => {
      raiseSyntheticBanner('quota');
      raiseSyntheticBanner('crash');
    });
    render(<BannerHost />);
    expect(screen.getByText(/shell exited unexpectedly/iu)).toBeInTheDocument();
    expect(screen.queryByText(/history storage/iu)).toBeNull();
  });

  it('secret_rescan + shell_integration: only secret_rescan visible', () => {
    act(() => {
      raiseSyntheticBanner('shell_integration');
      raiseSyntheticBanner('secret_rescan');
    });
    render(<BannerHost />);
    expect(screen.getByText(/secret redaction rules/iu)).toBeInTheDocument();
    expect(screen.queryByText(/shell integration is not installed/iu)).toBeNull();
  });
});
