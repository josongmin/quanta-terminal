/**
 * FindPanel widget tests — grid-wide find surface (Plan 0005 P1-F).
 *
 * The pure indexer logic is covered by
 * `features/output-search/__tests__/scrollback-search.test.ts`; this file
 * asserts the widget's own behaviour:
 *   1. Hidden while closed, visible once the store opens.
 *   2. Debounced recompute populates the match count.
 *   3. Enter / Shift+Enter move the current index with wrap.
 *   4. Escape closes the store.
 *   5. The toggles mutate the store.
 *   6. `onScrollToMatch` fires with the active match (or `null`).
 *   7. Invalid regex surfaces as "invalid regex" inline.
 *   8. `setMatches` stability — equal `(rowId, startCol)` preserves index.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FindPanel } from '../FindPanel.js';
import { useFindPanelStore } from '../find-panel-store.js';
import type {
  GridSearchEmulator,
  GridSearchMatch,
} from '../../../features/output-search/scrollback-search.js';

/** Minimal emulator stub reused from the indexer tests. */
function makeEmulator(lines: readonly string[]): GridSearchEmulator {
  const cols = 80;
  const toCells = (line: string) => {
    const cells: { grapheme: string; width: 0 | 1 | 2 }[] = [];
    for (const ch of line) cells.push({ grapheme: ch, width: 1 });
    while (cells.length < cols) cells.push({ grapheme: '', width: 1 });
    return cells;
  };
  const scrollback = { rows: [], baseRowId: 0 };
  const viewport = lines.map(toCells);
  return {
    getScrollback: () => scrollback,
    getViewportRows: () => viewport,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useFindPanelStore.getState()._reset();
});

describe('<FindPanel />', () => {
  it('renders nothing while closed', () => {
    render(<FindPanel getEmulator={() => null} debounceMs={0} />);
    expect(screen.queryByTestId('find-panel')).toBeNull();
  });

  it('renders once the store is open', () => {
    useFindPanelStore.getState().setOpen(true);
    render(<FindPanel getEmulator={() => null} debounceMs={0} />);
    expect(screen.getByTestId('find-panel')).toBeInTheDocument();
  });

  it('debounced recompute populates match count', async () => {
    const em = makeEmulator(['foo bar', 'foo baz', 'bar qux']);
    useFindPanelStore.getState().setOpen(true);
    render(<FindPanel getEmulator={() => em} debounceMs={150} />);
    const input = screen.getByTestId('find-panel-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    // Before the debounce elapses, the store's match list is still empty.
    expect(screen.getByTestId('find-panel-count').textContent).toBe('no matches');
    await act(async () => {
      vi.advanceTimersByTime(160);
    });
    expect(screen.getByTestId('find-panel-count').textContent).toBe('1 of 2');
  });

  it('Enter advances currentIndex, Shift+Enter rewinds with wrap', async () => {
    const em = makeEmulator(['foo', 'foo', 'foo']);
    useFindPanelStore.getState().setOpen(true);
    render(<FindPanel getEmulator={() => em} debounceMs={0} />);
    const input = screen.getByTestId('find-panel-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    await act(async () => {
      vi.advanceTimersByTime(5);
    });
    expect(useFindPanelStore.getState().currentIndex).toBe(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useFindPanelStore.getState().currentIndex).toBe(1);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(useFindPanelStore.getState().currentIndex).toBe(0);
    // Wrap.
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(useFindPanelStore.getState().currentIndex).toBe(2);
  });

  it('Escape closes the store', () => {
    const em = makeEmulator([]);
    useFindPanelStore.getState().setOpen(true);
    render(<FindPanel getEmulator={() => em} debounceMs={0} />);
    const input = screen.getByTestId('find-panel-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useFindPanelStore.getState().open).toBe(false);
  });

  it('toggles update the store (case / word / regex)', () => {
    const em = makeEmulator([]);
    useFindPanelStore.getState().setOpen(true);
    render(<FindPanel getEmulator={() => em} debounceMs={0} />);
    fireEvent.click(screen.getByTestId('find-panel-toggle-case'));
    expect(useFindPanelStore.getState().caseSensitive).toBe(true);
    fireEvent.click(screen.getByTestId('find-panel-toggle-word'));
    expect(useFindPanelStore.getState().wholeWord).toBe(true);
    fireEvent.click(screen.getByTestId('find-panel-toggle-regex'));
    expect(useFindPanelStore.getState().regex).toBe(true);
  });

  it('fires onScrollToMatch when the active match changes', async () => {
    const em = makeEmulator(['foo', 'foo']);
    const calls: (GridSearchMatch | null)[] = [];
    useFindPanelStore.getState().setOpen(true);
    render(
      <FindPanel
        getEmulator={() => em}
        onScrollToMatch={(m) => calls.push(m)}
        debounceMs={0}
      />,
    );
    const input = screen.getByTestId('find-panel-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    await act(async () => {
      vi.advanceTimersByTime(5);
    });
    // After the debounce, a non-null match should have been pushed.
    const nonNull = calls.filter((c) => c !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    expect(nonNull[0]!.rowId).toBe(0);
  });

  it('invalid regex surfaces as "invalid regex"', async () => {
    const em = makeEmulator(['hello']);
    useFindPanelStore.getState().setOpen(true);
    useFindPanelStore.getState().setRegex(true);
    render(<FindPanel getEmulator={() => em} debounceMs={0} />);
    const input = screen.getByTestId('find-panel-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '[' } });
    await act(async () => {
      vi.advanceTimersByTime(5);
    });
    expect(screen.getByTestId('find-panel-count').textContent).toBe('invalid regex');
  });

  it('Cmd+F via keymap toggles the store and Esc closes it (Plan 0005 P1-F wave 1)', async () => {
    // Uses the same `useKeymap` wiring TerminalPage uses. We render a tiny
    // host that declares `mod+f → useFindPanelStore.toggle` so the test
    // proves the integration contract without pulling the whole
    // TerminalPage (which has a large dependency graph). `userEvent` sends
    // real keyboard events through the DOM so the keymap's window listener
    // fires and the store flips.
    vi.useRealTimers();
    const { useKeymap } = await import('../../../shared/lib/keymap.js');
    const userEvent = (await import('@testing-library/user-event')).default;
    function Host() {
      useKeymap(
        'mod+f',
        (e) => {
          e.preventDefault();
          useFindPanelStore.getState().toggle();
        },
        { allowInEditable: true },
      );
      return <FindPanel getEmulator={() => null} debounceMs={0} />;
    }
    const isMac =
      typeof navigator !== 'undefined' && /mac/iu.test(navigator.platform ?? '');
    const user = userEvent.setup();
    render(<Host />);
    expect(screen.queryByTestId('find-panel')).toBeNull();
    await user.keyboard(isMac ? '{Meta>}f{/Meta}' : '{Control>}f{/Control}');
    expect(screen.getByTestId('find-panel')).toBeInTheDocument();
    expect(useFindPanelStore.getState().open).toBe(true);
    // Focus lands on the input — Escape must close.
    await user.keyboard('{Escape}');
    expect(useFindPanelStore.getState().open).toBe(false);
    vi.useFakeTimers();
  });

  it('store: equal (rowId, startCol) preserves currentIndex', () => {
    const { setMatches, setCurrentIndex } = useFindPanelStore.getState();
    const first: GridSearchMatch[] = [
      { rowId: 0, startCol: 0, endColExclusive: 3, text: 'foo' },
      { rowId: 1, startCol: 0, endColExclusive: 3, text: 'foo' },
      { rowId: 2, startCol: 0, endColExclusive: 3, text: 'foo' },
    ];
    setMatches(first);
    setCurrentIndex(1);
    // A re-index shuffles — rowIds might have drifted upward as old rows
    // were evicted. Index 1 from the old list (`rowId: 1`) should be found
    // at its new position.
    const second: GridSearchMatch[] = [
      { rowId: 1, startCol: 0, endColExclusive: 3, text: 'foo' },
      { rowId: 2, startCol: 0, endColExclusive: 3, text: 'foo' },
    ];
    setMatches(second);
    expect(useFindPanelStore.getState().currentIndex).toBe(0);
  });
});
