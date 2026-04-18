import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tooltip } from '../Tooltip.js';

describe('<Tooltip />', () => {
  it('renders content inside a role=tooltip element', () => {
    render(
      <Tooltip content="cwd is estimated from prompt text">
        <button>est</button>
      </Tooltip>,
    );
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip).toHaveTextContent('cwd is estimated from prompt text');
  });

  it('associates the trigger with aria-describedby', () => {
    const { container } = render(
      <Tooltip content="explain me">
        <button>trigger</button>
      </Tooltip>,
    );
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('uses unique ids for multiple tooltips on the same page', () => {
    const { container } = render(
      <div>
        <Tooltip content="a">
          <button>a</button>
        </Tooltip>
        <Tooltip content="b">
          <button>b</button>
        </Tooltip>
      </div>,
    );
    const wraps = container.firstElementChild!.children;
    const idA = wraps[0]!.getAttribute('aria-describedby');
    const idB = wraps[1]!.getAttribute('aria-describedby');
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });
});
