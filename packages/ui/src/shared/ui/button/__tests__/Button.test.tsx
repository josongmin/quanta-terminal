import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { Button } from '../Button.js';
import type { ButtonVariant } from '../Button.js';

describe('<Button />', () => {
  it('renders a button with default type=button', () => {
    render(<Button>Open</Button>);
    const el = screen.getByRole('button', { name: 'Open' });
    expect(el).toHaveAttribute('type', 'button');
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    screen.getByRole('button', { name: 'Go' }).click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  // One test per variant. `default` does NOT emit a variant-default class by
  // design (it's the base style), so we assert absence rather than presence.
  const variants: readonly ButtonVariant[] = ['default', 'primary', 'ghost'];
  it.each(variants)('applies variant=%s correctly', (variant) => {
    render(<Button variant={variant}>x</Button>);
    const el = screen.getByRole('button');
    if (variant === 'default') {
      expect(el.className).not.toMatch(/variant-default/u);
    } else {
      expect(el.className).toMatch(new RegExp(`variant-${variant}`, 'u'));
    }
  });

  it('forwards ref to the underlying <button>', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>x</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('respects an explicit type override', () => {
    render(<Button type="submit">submit</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });
});
