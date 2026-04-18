import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Banner } from '../Banner.js';
import type { BannerKind } from '../Banner.js';

describe('<Banner />', () => {
  it('renders its message and is announced politely', () => {
    render(<Banner>Shell integration missing for zsh.</Banner>);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-live', 'polite');
    expect(el).toHaveTextContent('Shell integration missing for zsh.');
  });

  // One test per kind variant — matches the ADR 0010 precedence taxonomy and
  // keeps OCP honest (new kinds must extend via a row, not a new component).
  const kinds: readonly BannerKind[] = ['info', 'warning', 'danger'];
  it.each(kinds)('applies kind=%s as an additive class', (kind) => {
    render(<Banner kind={kind}>hi</Banner>);
    const el = screen.getByRole('status');
    expect(el.className).toMatch(new RegExp(`kind-${kind}`, 'u'));
  });

  it('calls onDismiss', async () => {
    const onDismiss = vi.fn();
    render(
      <Banner onDismiss={onDismiss} kind="warning">
        Storage above soft quota.
      </Banner>,
    );
    const btn = screen.getByRole('button', { name: 'Dismiss' });
    btn.click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('hides the dismiss button when onDismiss is omitted', () => {
    render(<Banner>ambient</Banner>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders an action slot when provided', () => {
    render(<Banner action={<button>Install</button>}>Install shell integration.</Banner>);
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
  });
});
