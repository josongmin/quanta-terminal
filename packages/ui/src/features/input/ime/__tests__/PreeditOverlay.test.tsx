import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PreeditOverlay } from '../PreeditOverlay';

describe('PreeditOverlay', () => {
  it('renders text at the given absolute position', () => {
    const { container } = render(
      <PreeditOverlay text="한" anchor={{ row: 3, col: 5, x: 40, y: 60 }} />,
    );
    const el = container.querySelector('.quanta-preedit-overlay') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('한');
    expect(el.style.position).toBe('absolute');
    expect(el.style.left).toBe('40px');
    expect(el.style.top).toBe('60px');
    expect(el.style.textDecoration).toMatch(/underline/);
  });

  it('applies opacity when dimmed', () => {
    const { container } = render(
      <PreeditOverlay text="ㅎ" anchor={{ row: 0, col: 0, x: 0, y: 0 }} dimmed />,
    );
    const el = container.querySelector('.quanta-preedit-overlay') as HTMLElement;
    expect(el.style.opacity).toBe('0.5');
    expect(el.style.pointerEvents).toBe('none');
    expect(el.getAttribute('data-dimmed')).toBe('true');
  });

  it('fires onMeasure after mount with a DOMRect-shaped object', () => {
    const onMeasure = vi.fn();
    render(
      <PreeditOverlay text="hi" anchor={{ row: 1, col: 1, x: 0, y: 0 }} onMeasure={onMeasure} />,
    );
    expect(onMeasure).toHaveBeenCalledTimes(1);
    const rect = onMeasure.mock.calls[0]![0] as DOMRect;
    expect(typeof rect.width).toBe('number');
    expect(typeof rect.height).toBe('number');
  });

  it('updates position on anchor change without remount', () => {
    const { container, rerender } = render(
      <PreeditOverlay text="hi" anchor={{ row: 0, col: 0, x: 10, y: 10 }} />,
    );
    const first = container.querySelector('.quanta-preedit-overlay') as HTMLElement;
    rerender(<PreeditOverlay text="hi" anchor={{ row: 2, col: 2, x: 30, y: 40 }} />);
    const second = container.querySelector('.quanta-preedit-overlay') as HTMLElement;
    expect(second).toBe(first);
    expect(second.style.left).toBe('30px');
    expect(second.style.top).toBe('40px');
  });

  it('carries data-row / data-col attributes for cell positioning tests', () => {
    const { container } = render(
      <PreeditOverlay text="z" anchor={{ row: 7, col: 11 }} />,
    );
    const el = container.querySelector('.quanta-preedit-overlay') as HTMLElement;
    expect(el.getAttribute('data-row')).toBe('7');
    expect(el.getAttribute('data-col')).toBe('11');
  });
});
