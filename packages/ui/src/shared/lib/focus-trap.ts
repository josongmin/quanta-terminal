/**
 * Focus trap — small, dependency-free utility used by the command palette
 * (and any future modal). Activates on an element; Tab / Shift+Tab wrap
 * through the focusable descendants, and Escape is the caller's problem.
 *
 * Scope: Phase-1. We deliberately do not implement the more permissive
 * "return focus on deactivate" that `focus-trap` (the npm package) offers;
 * the palette handles that via the ref it keeps of the previous active
 * element. This module focuses (pun) on the trap itself.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

export function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const list: HTMLElement[] = [];
  nodes.forEach((n) => {
    // Skip explicitly hidden elements, but keep everything else — jsdom
    // doesn't compute offsetParent for unstyled elements, so we can't use
    // that heuristic to filter. Visibility screening is a host concern the
    // caller can perform when needed.
    if (n.hasAttribute('hidden')) return;
    if (n.getAttribute('aria-hidden') === 'true') return;
    list.push(n);
  });
  return list;
}

export interface TrapHandle {
  readonly deactivate: () => void;
}

/**
 * Activate a focus trap on `container`. Tab cycles forward; Shift+Tab cycles
 * back. Returns a handle whose `deactivate` removes the listener — the
 * caller is responsible for returning focus to the previous element.
 */
export function activateFocusTrap(container: HTMLElement): TrapHandle {
  const handler = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const focusables = getFocusable(container);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  container.addEventListener('keydown', handler);

  return {
    deactivate: () => {
      container.removeEventListener('keydown', handler);
    },
  };
}
