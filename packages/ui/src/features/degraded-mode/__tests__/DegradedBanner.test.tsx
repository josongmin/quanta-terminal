/**
 * DegradedBanner — presentational tests.
 *
 *   1. Renders the localized copy from the i18n table.
 *   2. `Restart session` button fires the onRestart handler.
 *   3. During restart the button is disabled (prevents double-click).
 *   4. Carries `role="alert"` so screen readers announce the outage.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DegradedBanner } from '../DegradedBanner.js';

afterEach(() => {
  cleanup();
});

describe('<DegradedBanner />', () => {
  it('renders the engine-crashed copy from the localization table', () => {
    render(<DegradedBanner onRestart={() => {}} />);
    const banner = screen.getByTestId('degraded-banner');
    expect(banner.textContent).toMatch(/Engine crashed/u);
    expect(banner.textContent).toMatch(/last frame preserved/u);
  });

  it('exposes an assertive alert role so screen readers catch it', () => {
    render(<DegradedBanner onRestart={() => {}} />);
    const banner = screen.getByTestId('degraded-banner');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
  });

  it('fires onRestart when the button is clicked', () => {
    const onRestart = vi.fn();
    render(<DegradedBanner onRestart={onRestart} />);
    const btn = screen.getByTestId('degraded-banner-restart');
    fireEvent.click(btn);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('disables the button during an async restart to prevent double-click', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    const onRestart = vi.fn(async () => {
      await pending;
    });
    render(<DegradedBanner onRestart={onRestart} />);
    const btn = screen.getByTestId('degraded-banner-restart') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    // The second click must be a no-op — onRestart was only invoked once.
    expect(onRestart).toHaveBeenCalledTimes(1);
    resolve();
    await pending;
    // Let the microtask queue flush so state resets.
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.disabled).toBe(false);
  });

  it('records the reason on the banner dataset', () => {
    render(<DegradedBanner onRestart={() => {}} reason="stream_silent" />);
    const banner = screen.getByTestId('degraded-banner');
    expect(banner.dataset['reason']).toBe('stream_silent');
  });

  it('defaults the reason to engine_crashed when omitted', () => {
    render(<DegradedBanner onRestart={() => {}} />);
    const banner = screen.getByTestId('degraded-banner');
    expect(banner.dataset['reason']).toBe('engine_crashed');
  });
});
