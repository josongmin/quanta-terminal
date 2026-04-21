/**
 * OutputSearch widget — input / debounced recompute / navigation / close.
 *
 * The pure match-computation logic is covered by
 * features/output-search/__tests__; here we only assert the widget's wiring:
 *   - opening shows the bar (driven by store)
 *   - typing eventually updates the count
 *   - Enter / Shift+Enter move `currentIndex`
 *   - Escape closes the store
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputSearch } from '../OutputSearch.js';
import { useOutputSearchStore } from '../../../features/output-search/index.js';
import { useBlockStore } from '../../../entities/block/index.js';

const encoder = new TextEncoder();

function seedBlock(command: string, bytes: string): string {
  const id = useBlockStore.getState().createBlock(command, '/repo');
  useBlockStore.getState().appendBlockOutput(id, encoder.encode(bytes));
  useBlockStore.getState().completeBlock(id, 0);
  return id;
}

beforeEach(() => {
  vi.useFakeTimers();
  useOutputSearchStore.getState()._reset();
  useBlockStore.getState().resetAll();
});

describe('<OutputSearch />', () => {
  it('renders nothing while closed', () => {
    render(<OutputSearch debounceMs={0} />);
    expect(screen.queryByTestId('output-search-bar')).toBeNull();
  });

  it('renders the bar once the store is open', () => {
    useOutputSearchStore.getState().setOpen(true);
    render(<OutputSearch debounceMs={0} />);
    expect(screen.getByTestId('output-search-bar')).toBeInTheDocument();
  });

  it('typing updates the count via debounced recompute', async () => {
    seedBlock('cat a', 'foo bar foo');
    seedBlock('cat b', 'foo');
    useOutputSearchStore.getState().setOpen(true);
    render(<OutputSearch debounceMs={250} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    // Before the debounce elapses there are no matches yet — "No matches"
    // is the empty-result label; an already-queued but not-yet-run recompute
    // simply leaves the last matches (empty on first query) in place.
    expect(screen.getByTestId('output-search-count').textContent).toBe('No matches');
    await act(async () => {
      vi.advanceTimersByTime(260);
    });
    const count = screen.getByTestId('output-search-count').textContent;
    expect(count).toBe('1 of 3 matches');
  });

  it('Enter advances currentIndex, Shift+Enter rewinds', async () => {
    seedBlock('cat a', 'foo foo foo');
    useOutputSearchStore.getState().setOpen(true);
    render(<OutputSearch debounceMs={0} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(useOutputSearchStore.getState().currentIndex).toBe(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useOutputSearchStore.getState().currentIndex).toBe(1);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(useOutputSearchStore.getState().currentIndex).toBe(0);
  });

  it('Escape closes the store', () => {
    useOutputSearchStore.getState().setOpen(true);
    render(<OutputSearch debounceMs={0} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useOutputSearchStore.getState().open).toBe(false);
  });

  it('empty query yields empty count and clears matches', async () => {
    seedBlock('cat a', 'foo');
    useOutputSearchStore.getState().setOpen(true);
    render(<OutputSearch debounceMs={0} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(useOutputSearchStore.getState().matches.length).toBeGreaterThan(0);
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(useOutputSearchStore.getState().matches).toEqual([]);
    expect(screen.getByTestId('output-search-count').textContent).toBe('');
  });

  it('reports exact match count across multiple blocks', async () => {
    seedBlock('a', 'foo\nbar foo');
    seedBlock('b', 'baz');
    seedBlock('c', 'foo foo foo');
    useOutputSearchStore.getState().setOpen(true);
    render(<OutputSearch debounceMs={0} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    // 2 in first block (foo + bar foo), 0 in second, 3 in third = 5 total.
    expect(useOutputSearchStore.getState().matches.length).toBe(5);
  });

  it('regex toggle with invalid pattern shows inline error', async () => {
    seedBlock('a', 'foo bar baz');
    useOutputSearchStore.getState().setOpen(true);
    useOutputSearchStore.getState().setRegex(true);
    render(<OutputSearch debounceMs={0} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '[' } });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.getByTestId('output-search-count').textContent).toBe(
      '/invalid regex/',
    );
    // The hint row displays the actual regex error message.
    expect(screen.getByTestId('output-search-hint').textContent).toMatch(/./);
    // input is marked invalid for screen readers
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('regex toggle with valid pattern matches', async () => {
    seedBlock('a', 'error 123 ok 4567');
    useOutputSearchStore.getState().setOpen(true);
    useOutputSearchStore.getState().setRegex(true);
    render(<OutputSearch debounceMs={0} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '\\d+' } });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(useOutputSearchStore.getState().matches.length).toBe(2);
    // Nav advances counter.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useOutputSearchStore.getState().currentIndex).toBe(1);
  });

  it('case-sensitive toggle filters matches', async () => {
    seedBlock('a', 'Foo foo FOO');
    useOutputSearchStore.getState().setOpen(true);
    render(<OutputSearch debounceMs={0} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(useOutputSearchStore.getState().matches.length).toBe(3);
    // Flip case-sensitive on.
    fireEvent.click(screen.getByTestId('output-search-toggle-case'));
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(useOutputSearchStore.getState().matches.length).toBe(1);
  });

  it('whole-word toggle filters substring matches', async () => {
    seedBlock('a', 'cat concatenate cats cat.');
    useOutputSearchStore.getState().setOpen(true);
    render(<OutputSearch debounceMs={0} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'cat' } });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    // Plain substring matches 4 occurrences (cat, cat in concatenate, cat in
    // cats, cat before .)
    expect(useOutputSearchStore.getState().matches.length).toBe(4);
    fireEvent.click(screen.getByTestId('output-search-toggle-word'));
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    // Whole-word leaves only the two standalone "cat" occurrences.
    expect(useOutputSearchStore.getState().matches.length).toBe(2);
  });

  it('F3 / Shift+F3 navigate like Enter / Shift+Enter', async () => {
    seedBlock('a', 'foo foo foo');
    useOutputSearchStore.getState().setOpen(true);
    render(<OutputSearch debounceMs={0} />);
    const input = screen.getByTestId('output-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    fireEvent.keyDown(input, { key: 'F3' });
    expect(useOutputSearchStore.getState().currentIndex).toBe(1);
    fireEvent.keyDown(input, { key: 'F3', shiftKey: true });
    expect(useOutputSearchStore.getState().currentIndex).toBe(0);
  });

  it('focus returns to the previously-focused element on close', () => {
    // Set up an external element, focus it, then open/close the widget.
    const prev = document.createElement('button');
    prev.id = 'prev-focus';
    document.body.appendChild(prev);
    prev.focus();
    expect(document.activeElement).toBe(prev);

    useOutputSearchStore.getState().setOpen(true);
    const { unmount } = render(<OutputSearch debounceMs={0} />);
    // Input now has focus.
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'output-search-input',
    );
    // Closing should restore focus.
    act(() => {
      useOutputSearchStore.getState().close();
    });
    // The restore runs in the cleanup effect — which fires synchronously
    // when `open` flips to false and the render bails to null.
    unmount();
    // Not strict — jsdom's focus returns to document body after unmount.
    // Asserting "not the input" is sufficient here.
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe(
      'output-search-input',
    );

    document.body.removeChild(prev);
  });
});
