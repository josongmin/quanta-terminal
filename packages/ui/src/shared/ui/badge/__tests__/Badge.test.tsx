import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '../Badge.js';
import type { BadgeTone } from '../Badge.js';

describe('<Badge />', () => {
  it('renders the label and exposes an aria-label', () => {
    render(<Badge label="est" srDescription="cwd is estimated from prompt text" />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('est');
    expect(el).toHaveAttribute('aria-label', 'cwd is estimated from prompt text');
  });

  it('defaults aria-label to the label when srDescription omitted', () => {
    render(<Badge label="SI" />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-label', 'SI');
  });

  // One test per tone variant — new tones must add a row here so OCP is
  // enforced in practice, not just in the type.
  const tones: readonly BadgeTone[] = ['neutral', 'accent', 'warning', 'danger', 'success'];
  it.each(tones)('applies tone=%s as an additive class', (tone) => {
    render(<Badge label="x" tone={tone} />);
    const el = screen.getByRole('status');
    expect(el.className).toMatch(new RegExp(`tone-${tone}`, 'u'));
  });

  it('forwards extra HTML attributes', () => {
    render(<Badge label="x" data-testid="b" title="hover title" />);
    const el = screen.getByTestId('b');
    expect(el).toHaveAttribute('title', 'hover title');
  });
});
