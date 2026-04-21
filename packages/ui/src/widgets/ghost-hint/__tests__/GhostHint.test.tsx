/**
 * GhostHint — widget tests (Plan 0005 P1-G).
 *
 * Test matrix (13 cases):
 *  1. renders nothing when the mode stack is empty
 *  2. renders the hint text for pager_less
 *  3. renders the hint text for repl_python
 *  4. renders the hint text for tui_vim
 *  5. renders the hint for the top layer (nested tmux+vim -> vim)
 *  6. skips unknown layer kinds and falls through to a known layer below
 *  7. renders nothing when the only layer is unknown (no fallback)
 *  8. exposes aria-live="polite" + aria-label + role="status" + tabindex=0
 *  9. auto-dismisses after 3s (data-dismissed flips to 'true')
 * 10. re-shows when a new layer is pushed on top
 * 11. hover cancels auto-dismiss and un-dismisses
 * 12. autoDismissMs=0 disables the auto-dismiss (persistent hint)
 * 13. focus re-shows the hint for keyboard users
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GhostHint } from '../GhostHint.js';
import type { ModeStackSnapshot } from '../useModeStack.js';

function makeStack(kinds: readonly string[]): ModeStackSnapshot {
  return { layers: kinds.map((kind) => ({ kind })) };
}

function makeStackHook(snapshot: ModeStackSnapshot): () => ModeStackSnapshot {
  return () => snapshot;
}

describe('<GhostHint />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when the mode stack is empty', () => {
    render(<GhostHint stackHook={makeStackHook(makeStack([]))} />);
    expect(screen.queryByTestId('ghost-hint')).toBeNull();
  });

  it('renders the hint text for pager_less', () => {
    render(<GhostHint stackHook={makeStackHook(makeStack(['pager_less']))} />);
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.textContent).toMatch(/press q to quit/);
    expect(pill.dataset['kind']).toBe('pager_less');
  });

  it('renders the hint text for repl_python', () => {
    render(<GhostHint stackHook={makeStackHook(makeStack(['repl_python']))} />);
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.textContent).toMatch(/exit\(\) or \^D/);
  });

  it('renders the hint text for tui_vim', () => {
    render(<GhostHint stackHook={makeStackHook(makeStack(['tui_vim']))} />);
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.textContent).toMatch(/:q to quit/);
  });

  it('renders the hint for the topmost layer (tmux -> vim shows vim)', () => {
    render(
      <GhostHint
        stackHook={makeStackHook(makeStack(['multiplexer_tmux', 'tui_vim']))}
      />,
    );
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.dataset['kind']).toBe('tui_vim');
    expect(pill.textContent).toMatch(/:q to quit/);
  });

  it('falls through to a known layer below an unknown top layer', () => {
    render(
      <GhostHint
        stackHook={makeStackHook(makeStack(['pager_less', 'ai_overlay']))}
      />,
    );
    // `ai_overlay` is unknown -> skip; fall back to `pager_less`.
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.dataset['kind']).toBe('pager_less');
    expect(pill.textContent).toMatch(/press q to quit/);
  });

  it('renders nothing when the only layer is unknown', () => {
    render(<GhostHint stackHook={makeStackHook(makeStack(['ai_overlay']))} />);
    expect(screen.queryByTestId('ghost-hint')).toBeNull();
  });

  it('exposes role=status, aria-live=polite, aria-label, tabindex=0', () => {
    render(<GhostHint stackHook={makeStackHook(makeStack(['pager_less']))} />);
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.getAttribute('role')).toBe('status');
    expect(pill.getAttribute('aria-live')).toBe('polite');
    expect(pill.getAttribute('aria-label')).toMatch(/Hint:/);
    expect(pill.getAttribute('aria-label')).toMatch(/press q to quit/);
    expect(pill.getAttribute('tabindex')).toBe('0');
  });

  it('auto-dismisses after 3s (data-dismissed flips to true)', () => {
    render(<GhostHint stackHook={makeStackHook(makeStack(['tui_vim']))} />);
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.dataset['dismissed']).toBe('false');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(pill.dataset['dismissed']).toBe('true');
  });

  it('re-shows when a new layer is pushed on top', () => {
    const { rerender } = render(
      <GhostHint stackHook={makeStackHook(makeStack(['pager_less']))} />,
    );
    // Let the first hint auto-dismiss.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('ghost-hint').dataset['dismissed']).toBe('true');
    // Push a new layer — dismissal resets.
    rerender(
      <GhostHint
        stackHook={makeStackHook(makeStack(['pager_less', 'tui_vim']))}
      />,
    );
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.dataset['kind']).toBe('tui_vim');
    expect(pill.dataset['dismissed']).toBe('false');
  });

  it('hover cancels auto-dismiss and un-dismisses', () => {
    render(<GhostHint stackHook={makeStackHook(makeStack(['pager_man']))} />);
    const pill = screen.getByTestId('ghost-hint');
    // Let it auto-dismiss first…
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(pill.dataset['dismissed']).toBe('true');
    // …then hover to un-dismiss.
    act(() => {
      fireEvent.mouseEnter(pill);
    });
    expect(pill.dataset['dismissed']).toBe('false');
    // Subsequent timer ticks should NOT re-dismiss (timer was cleared).
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(pill.dataset['dismissed']).toBe('false');
  });

  it('autoDismissMs=0 disables the auto-dismiss (persistent hint)', () => {
    render(
      <GhostHint
        stackHook={makeStackHook(makeStack(['repl_node']))}
        autoDismissMs={0}
      />,
    );
    const pill = screen.getByTestId('ghost-hint');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(pill.dataset['dismissed']).toBe('false');
  });

  it('focus re-shows the hint for keyboard users', () => {
    render(<GhostHint stackHook={makeStackHook(makeStack(['tui_htop']))} />);
    const pill = screen.getByTestId('ghost-hint');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(pill.dataset['dismissed']).toBe('true');
    act(() => {
      fireEvent.focus(pill);
    });
    expect(pill.dataset['dismissed']).toBe('false');
  });
});
