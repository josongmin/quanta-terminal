/**
 * BlockCard — alt-screen chrome collapse (EPIC-H §4.2).
 *
 * Tests that:
 *   1. Chrome is NOT collapsed for a non-running block even when alt-screen
 *      is active.
 *   2. Chrome collapses when the TUI store flips active AND this card is
 *      the running block for the owning session.
 *   3. `data-alt-depth` reflects the store's nesting depth (nested enters
 *      bump the counter visibly on the DOM but do not re-run animations).
 *   4. The rerun + compare + pin buttons are hidden during alt-screen;
 *      the copy button remains for the user to grab output.
 *   5. When the store flips `crashed`, the card wears the `altScreenCrashed`
 *      modifier so the border glows danger.
 *   6. Exiting alt-screen (depth 0) removes the collapsed modifier.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlockCard } from '../BlockCard.js';
import { useBlockStore } from '../../../entities/block/index.js';
import { useTuiStore } from '../../../entities/tui/index.js';
import type { Block } from '../../../entities/block/index.js';

function runningBlock(id: string, sessionId: string): Block {
  return {
    id,
    sessionId: sessionId as unknown as Block['sessionId'],
    command: 'vim',
    status: 'running',
    cwd: '/',
    startedAt: Date.now(),
    completedAt: null,
    exitCode: null,
    outputChunks: [],
    collapsed: false,
    pinned: false,
    errorMessage: null,
    rerunOfId: null,
    tags: [],
  };
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useTuiStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('<BlockCard /> — alt-screen collapse', () => {
  it('does not collapse a completed block even when alt-screen is active', () => {
    const completed: Block = { ...runningBlock('blk-1', 'sess-1'), status: 'completed', exitCode: 0 };
    useBlockStore.setState((prev) => ({
      ...prev,
      order: [...prev.order, completed.id],
      entities: { ...prev.entities, [completed.id]: completed },
    }));
    render(<BlockCard block={completed} />);
    act(() => {
      useTuiStore.getState().enter({ command: 'vim', sessionId: 'sess-1' as never });
    });
    const card = screen.getByTestId('block-card-blk-1');
    expect(card.dataset['altScreen']).toBe('false');
    expect(card.className).not.toMatch(/altScreenCollapsed/);
  });

  it('collapses chrome when alt-screen is active for a running block in the same session', () => {
    const running = runningBlock('blk-2', 'sess-2');
    useBlockStore.setState((prev) => ({
      ...prev,
      order: [...prev.order, running.id],
      entities: { ...prev.entities, [running.id]: running },
    }));
    render(<BlockCard block={running} />);
    act(() => {
      useTuiStore.getState().enter({ command: 'vim', sessionId: 'sess-2' as never });
    });
    const card = screen.getByTestId('block-card-blk-2');
    expect(card.dataset['altScreen']).toBe('true');
    expect(card.className).toMatch(/altScreenCollapsed/);
  });

  it('surfaces nesting depth on the data-alt-depth attribute', () => {
    const running = runningBlock('blk-3', 'sess-3');
    useBlockStore.setState((prev) => ({
      ...prev,
      order: [...prev.order, running.id],
      entities: { ...prev.entities, [running.id]: running },
    }));
    render(<BlockCard block={running} />);
    act(() => {
      useTuiStore.getState().enter({ command: 'tmux', sessionId: 'sess-3' as never });
      useTuiStore.getState().enter({ command: 'vim in tmux' });
    });
    const card = screen.getByTestId('block-card-blk-3');
    expect(card.dataset['altDepth']).toBe('2');
  });

  it('hides pin / rerun / compare buttons during alt-screen but keeps copy', () => {
    const running = runningBlock('blk-4', 'sess-4');
    useBlockStore.setState((prev) => ({
      ...prev,
      order: [...prev.order, running.id],
      entities: { ...prev.entities, [running.id]: running },
    }));
    render(<BlockCard block={running} />);
    act(() => {
      useTuiStore.getState().enter({ command: 'vim', sessionId: 'sess-4' as never });
    });
    expect(screen.queryByTestId('block-card-rerun-blk-4')).toBeNull();
    expect(screen.queryByTestId('block-card-compare-blk-4')).toBeNull();
    expect(screen.getByTestId('block-card-copy-blk-4')).toBeInTheDocument();
  });

  it('applies the crashed modifier when the tui store reports a crash', () => {
    const running = runningBlock('blk-5', 'sess-5');
    useBlockStore.setState((prev) => ({
      ...prev,
      order: [...prev.order, running.id],
      entities: { ...prev.entities, [running.id]: running },
    }));
    render(<BlockCard block={running} />);
    act(() => {
      useTuiStore.getState().enter({ command: 'vim', sessionId: 'sess-5' as never });
      useTuiStore.getState().reportCrash('signal 9');
    });
    const card = screen.getByTestId('block-card-blk-5');
    expect(card.className).toMatch(/altScreenCrashed/);
  });

  it('removes the collapsed modifier when alt-screen fully exits (depth 0)', () => {
    const running = runningBlock('blk-6', 'sess-6');
    useBlockStore.setState((prev) => ({
      ...prev,
      order: [...prev.order, running.id],
      entities: { ...prev.entities, [running.id]: running },
    }));
    render(<BlockCard block={running} />);
    act(() => {
      useTuiStore.getState().enter({ command: 'vim', sessionId: 'sess-6' as never });
    });
    expect(screen.getByTestId('block-card-blk-6').className).toMatch(/altScreenCollapsed/);
    act(() => {
      useTuiStore.getState().exit();
    });
    const card = screen.getByTestId('block-card-blk-6');
    expect(card.className).not.toMatch(/altScreenCollapsed/);
    expect(card.dataset['altScreen']).toBe('false');
  });
});
