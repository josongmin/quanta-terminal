import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Separator } from '../Separator.js';

describe('<Separator />', () => {
  it('defaults to vertical and aria-hidden', () => {
    const { container } = render(<Separator />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.className).toMatch(/vertical/u);
  });

  it('renders a semantic separator when asked', () => {
    render(<Separator semantic orientation="horizontal" data-testid="s" />);
    const el = screen.getByTestId('s');
    expect(el).toHaveAttribute('role', 'separator');
    expect(el).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('applies horizontal class when orientation=horizontal', () => {
    const { container } = render(<Separator orientation="horizontal" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toMatch(/horizontal/u);
  });
});
