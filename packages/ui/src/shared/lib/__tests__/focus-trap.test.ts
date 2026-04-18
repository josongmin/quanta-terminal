import { afterEach, describe, expect, it } from 'vitest';
import { activateFocusTrap } from '../focus-trap.js';

let mount: HTMLDivElement | null = null;

afterEach(() => {
  if (mount) mount.remove();
  mount = null;
});

function render(html: string): HTMLDivElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  mount = div;
  return div;
}

function dispatchTab(target: HTMLElement, shift = false): void {
  const evt = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(evt);
}

describe('activateFocusTrap', () => {
  it('wraps Tab from last to first', () => {
    const container = render(
      '<div><button id="a">a</button><button id="b">b</button><button id="c">c</button></div>',
    ).firstElementChild as HTMLElement;
    const trap = activateFocusTrap(container);
    const last = container.querySelector<HTMLButtonElement>('#c')!;
    last.focus();
    expect(document.activeElement).toBe(last);
    dispatchTab(last);
    const first = container.querySelector<HTMLButtonElement>('#a')!;
    expect(document.activeElement).toBe(first);
    trap.deactivate();
  });

  it('wraps Shift+Tab from first to last', () => {
    const container = render(
      '<div><button id="a">a</button><button id="b">b</button></div>',
    ).firstElementChild as HTMLElement;
    const trap = activateFocusTrap(container);
    const first = container.querySelector<HTMLButtonElement>('#a')!;
    first.focus();
    dispatchTab(first, true);
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('#b'),
    );
    trap.deactivate();
  });

  it('deactivation removes the listener', () => {
    const container = render(
      '<div><button id="a">a</button><button id="b">b</button></div>',
    ).firstElementChild as HTMLElement;
    const trap = activateFocusTrap(container);
    trap.deactivate();
    const first = container.querySelector<HTMLButtonElement>('#a')!;
    first.focus();
    // With no trap active, Tab is a no-op in jsdom (no focus move).
    dispatchTab(first);
    expect(document.activeElement).toBe(first);
  });
});
