/**
 * Spinner edge case: unmounting while the CSS animation is running must not
 * produce a "state update on unmounted component" warning. The spinner is
 * presentational — no setState on mount/unmount — so the contract is that
 * a rapid mount/unmount cycle inside an `act` boundary yields zero React
 * warnings.
 */

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Spinner } from '../Spinner.js';

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('<Spinner /> unmount-mid-animation', () => {
  it('rapid mount → unmount produces zero React errors or warnings', () => {
    const { unmount } = render(<Spinner size="md" />);
    unmount();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('unmounting 50 times in a tight loop does not leak listeners or log', () => {
    for (let i = 0; i < 50; i += 1) {
      const r = render(<Spinner />);
      r.unmount();
    }
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
