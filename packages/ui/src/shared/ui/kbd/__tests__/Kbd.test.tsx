import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Kbd } from '../Kbd.js';

describe('<Kbd />', () => {
  it('renders a <kbd> with the provided label', () => {
    const { container } = render(<Kbd>Cmd</Kbd>);
    const el = container.querySelector('kbd');
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('Cmd');
  });

  it('forwards className and extra attributes', () => {
    render(
      <Kbd className="extra" data-testid="k">
        Ctrl
      </Kbd>,
    );
    const el = screen.getByTestId('k');
    expect(el.className).toMatch(/extra/u);
    expect(el.tagName.toLowerCase()).toBe('kbd');
  });
});
