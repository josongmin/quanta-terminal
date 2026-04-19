/**
 * SessionTabs — drag & drop reorder tests.
 *
 * We simulate HTML5 drag events via fireEvent. Since jsdom doesn't actually
 * run the full DnD layer, we pass a synthetic `dataTransfer` and rely on
 * the handlers' explicit `getData` / `setData` calls.
 */

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionsStore } from '../../../entities/session/index.js';
import { SessionTabs } from '../SessionTabs.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const DND_TAB_MIME = 'application/x-quanta-session-tab';

/**
 * Stub a horizontal rect on a DOM element so midpoint math in the drop
 * handler becomes deterministic. jsdom returns all-zero rects by default
 * which makes every drop land in "left half" territory.
 */
function stubRect(el: Element, left: number, width: number): void {
  const rect = {
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + width,
    bottom: 0,
    width,
    height: 24,
    toJSON() {
      return rect;
    },
  } as DOMRect;
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  });
}

/**
 * Create a drag-family event with a clientX that actually round-trips in jsdom.
 * `fireEvent.drop(el, { clientX })` does NOT set clientX on the resulting
 * Event because `clientX` is a read-only MouseEvent property; RTL's helper
 * ignores the init shape. We build the event manually via `createEvent.drop`
 * and then assign clientX.
 */
function dispatchDragEvent(
  type: 'dragstart' | 'dragover' | 'dragleave' | 'drop',
  el: Element,
  init: { dataTransfer?: DataTransfer; clientX?: number },
): void {
  const create =
    type === 'dragstart'
      ? createEvent.dragStart
      : type === 'dragover'
        ? createEvent.dragOver
        : type === 'dragleave'
          ? createEvent.dragLeave
          : createEvent.drop;
  const ev = create(el) as Event & { dataTransfer?: DataTransfer; clientX?: number };
  if (init.dataTransfer) {
    Object.defineProperty(ev, 'dataTransfer', {
      configurable: true,
      value: init.dataTransfer,
    });
  }
  if (init.clientX !== undefined) {
    Object.defineProperty(ev, 'clientX', {
      configurable: true,
      value: init.clientX,
    });
  }
  fireEvent(el, ev);
}

function makeDataTransfer() {
  const store = new Map<string, string>();
  const dt = {
    types: [] as string[],
    dropEffect: 'none',
    effectAllowed: 'none',
    setData(format: string, data: string) {
      store.set(format, data);
      if (!dt.types.includes(format)) dt.types = [...dt.types, format];
    },
    getData(format: string) {
      return store.get(format) ?? '';
    },
  };
  return dt as unknown as DataTransfer;
}

function seedThree() {
  const coll = useSessionsStore.getState();
  coll.addSession({ id: 'a' as SessionId, shell: '/bin/zsh', health: 'ready' });
  coll.addSession({ id: 'b' as SessionId, shell: '/bin/bash', health: 'ready' });
  coll.addSession({ id: 'c' as SessionId, shell: '/bin/fish', health: 'ready' });
}

beforeEach(() => {
  useSessionsStore.getState().reset();
});

describe('<SessionTabs /> drag & drop reorder', () => {
  it('renders tabs as draggable', () => {
    seedThree();
    render(<SessionTabs />);
    const tab = screen.getByTestId('session-tab-a');
    expect(tab.getAttribute('draggable')).toBe('true');
  });

  it('serializes the dragged tab id into the dataTransfer on dragstart', () => {
    seedThree();
    render(<SessionTabs />);
    const tab = screen.getByTestId('session-tab-a');
    const dataTransfer = makeDataTransfer();
    dispatchDragEvent('dragstart', tab, { dataTransfer });
    expect((dataTransfer as unknown as { getData: (t: string) => string }).getData(DND_TAB_MIME)).toBe('a');
  });

  it('reorders the store when dropping a tab onto a later sibling (insert-after)', () => {
    seedThree();
    render(<SessionTabs />);
    const dataTransfer = makeDataTransfer();
    const srcTab = screen.getByTestId('session-tab-a');
    const dropTarget = screen.getByTestId('session-tab-c');
    stubRect(dropTarget, 100, 100); // midpoint = 150
    dispatchDragEvent('dragstart', srcTab, { dataTransfer });
    dispatchDragEvent('dragover', dropTarget, { dataTransfer, clientX: 190 });
    dispatchDragEvent('drop', dropTarget, { dataTransfer, clientX: 190 });
    // Expected order after moving 'a' to the right of 'c': b, c, a
    expect(useSessionsStore.getState().order).toEqual(['b', 'c', 'a']);
  });

  it('reorders when dropping onto an earlier sibling (insert-before)', () => {
    seedThree();
    render(<SessionTabs />);
    const dataTransfer = makeDataTransfer();
    const srcTab = screen.getByTestId('session-tab-c');
    const dropTarget = screen.getByTestId('session-tab-a');
    stubRect(dropTarget, 100, 100); // midpoint = 150
    dispatchDragEvent('dragstart', srcTab, { dataTransfer });
    dispatchDragEvent('dragover', dropTarget, { dataTransfer, clientX: 110 });
    dispatchDragEvent('drop', dropTarget, { dataTransfer, clientX: 110 });
    expect(useSessionsStore.getState().order).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when dropping a tab onto itself', () => {
    seedThree();
    render(<SessionTabs />);
    const dataTransfer = makeDataTransfer();
    const tab = screen.getByTestId('session-tab-b');
    stubRect(tab, 100, 100);
    dispatchDragEvent('dragstart', tab, { dataTransfer });
    dispatchDragEvent('dragover', tab, { dataTransfer, clientX: 150 });
    dispatchDragEvent('drop', tab, { dataTransfer, clientX: 150 });
    expect(useSessionsStore.getState().order).toEqual(['a', 'b', 'c']);
  });

  it('ignores drops with no recognizable payload', () => {
    seedThree();
    render(<SessionTabs />);
    const dataTransfer = makeDataTransfer();
    const target = screen.getByTestId('session-tab-b');
    stubRect(target, 100, 100);
    dispatchDragEvent('drop', target, { dataTransfer, clientX: 110 });
    expect(useSessionsStore.getState().order).toEqual(['a', 'b', 'c']);
  });

  it('preserves the active session when reordering', () => {
    seedThree();
    useSessionsStore.getState().setActive('b' as SessionId);
    render(<SessionTabs />);
    const dataTransfer = makeDataTransfer();
    const src = screen.getByTestId('session-tab-a');
    const target = screen.getByTestId('session-tab-c');
    stubRect(target, 100, 100);
    dispatchDragEvent('dragstart', src, { dataTransfer });
    dispatchDragEvent('dragover', target, { dataTransfer, clientX: 190 });
    dispatchDragEvent('drop', target, { dataTransfer, clientX: 190 });
    expect(useSessionsStore.getState().activeId).toBe('b');
  });
});
