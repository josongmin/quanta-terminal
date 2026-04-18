import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Spinner } from '../Spinner.js';
import type { SpinnerSize } from '../Spinner.js';

describe('<Spinner />', () => {
  it('exposes role="status" with a default label', () => {
    render(<Spinner />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-label', 'Loading');
  });

  it('accepts a custom label', () => {
    render(<Spinner label="Connecting to pty" />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-label', 'Connecting to pty');
  });

  const sizes: readonly SpinnerSize[] = ['sm', 'md'];
  it.each(sizes)('applies size=%s as an additive class', (size) => {
    render(<Spinner size={size} />);
    const el = screen.getByRole('status');
    expect(el.className).toMatch(new RegExp(`size-${size}`, 'u'));
  });
});
