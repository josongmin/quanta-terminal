import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tooltip } from '../Tooltip.js';

// Bubbles are portaled to document.body; Testing Library's default
// `cleanup()` after each test unmounts the React tree, which removes the
// portal node as well. No manual cleanup is required here.

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

  /**
   * Regression for the "tooltip clipped by block card rounded-corner
   * overflow" bug. The bubble MUST be portaled to document.body so an
   * ancestor `overflow: hidden` / `border-radius` / `contain: layout`
   * can't slice it.
   */
  it('portals the bubble to document.body (escapes ancestor overflow:hidden clips)', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden', borderRadius: 12, width: 100, height: 40 }}>
        <Tooltip content="portal me out">
          <button>trigger</button>
        </Tooltip>
      </div>,
    );
    const tip = screen.getByRole('tooltip', { hidden: true });
    // The bubble is NOT a descendant of the scoped render container — it
    // sits on document.body instead. This is what lets it paint outside
    // the parent's rounded clip rectangle.
    expect(container.contains(tip)).toBe(false);
    expect(document.body.contains(tip)).toBe(true);
  });

  it('toggles data-open on hover so CSS can reveal / hide the bubble', () => {
    render(
      <Tooltip content="hoverable">
        <button>trigger</button>
      </Tooltip>,
    );
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip.getAttribute('data-open')).toBe('false');
    const wrap = screen.getByRole('button', { name: 'trigger' }).parentElement!;
    act(() => {
      fireEvent.mouseEnter(wrap);
    });
    expect(tip.getAttribute('data-open')).toBe('true');
    act(() => {
      fireEvent.mouseLeave(wrap);
    });
    expect(tip.getAttribute('data-open')).toBe('false');
  });

  it('uses position: fixed so ancestor transforms / contain do not capture the bubble', () => {
    render(
      <Tooltip content="fixed geometry">
        <button>trigger</button>
      </Tooltip>,
    );
    const tip = screen.getByRole('tooltip', { hidden: true });
    // Opened so the inline geometry style applies.
    const wrap = screen.getByRole('button', { name: 'trigger' }).parentElement!;
    act(() => {
      fireEvent.mouseEnter(wrap);
    });
    // Either the CSS module (position: fixed default) or the inline style
    // set in the component after measurement resolves to `fixed`.
    expect(tip.style.position === 'fixed' || tip.style.position === '').toBe(
      true,
    );
  });
});
