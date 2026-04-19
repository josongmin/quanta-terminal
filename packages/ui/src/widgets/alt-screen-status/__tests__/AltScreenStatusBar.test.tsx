/**
 * AltScreenStatusBar — widget tests.
 *
 * Covers the surface contract consumed by TerminalPage:
 *   1. renders `{command} · {session}` with the Ctrl-D hint when active.
 *   2. hides (opacity 0 + data-visible=false) when command is empty.
 *   3. shows the crash label in danger tone while `crashed` is set.
 *   4. shows a depth badge for nested alt-screen (depth >= 2).
 *   5. supports the 'instant' transition knob (data-transition attribute).
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AltScreenStatusBar } from '../AltScreenStatusBar.js';

describe('<AltScreenStatusBar />', () => {
  it('renders command, session tail, and the Ctrl-D exits hint', () => {
    render(<AltScreenStatusBar command="vim" sessionId="sess-abc-12345" depth={1} />);
    const bar = screen.getByTestId('alt-screen-status-bar');
    expect(bar.dataset['visible']).toBe('true');
    expect(bar.textContent).toMatch(/vim/);
    // Short session tail — last 8 chars.
    expect(bar.textContent).toMatch(/bc-12345/);
    expect(bar.textContent).toMatch(/Ctrl-D exits/);
  });

  it('is hidden when command is empty and not crashed', () => {
    render(<AltScreenStatusBar command="" sessionId="sess-1" depth={0} />);
    const bar = screen.getByTestId('alt-screen-status-bar');
    expect(bar.dataset['visible']).toBe('false');
    // `visible` CSS class is NOT applied.
    expect(bar.className).not.toMatch(/visible/);
  });

  it('renders the crash label and flips data-crashed to true', () => {
    render(
      <AltScreenStatusBar
        command="vim"
        sessionId="s"
        depth={1}
        crashed={{ reason: 'signal 9' }}
      />,
    );
    const bar = screen.getByTestId('alt-screen-status-bar');
    expect(bar.dataset['crashed']).toBe('true');
    expect(bar.textContent).toMatch(/exited with signal/);
    expect(bar.textContent).toMatch(/signal 9/);
    // The Ctrl-D hint is suppressed during crash.
    expect(bar.textContent).not.toMatch(/Ctrl-D exits/);
  });

  it('shows a depth badge for nested alt-screen (depth >= 2)', () => {
    render(<AltScreenStatusBar command="vim in tmux" sessionId="s" depth={2} />);
    const badge = screen.getByTestId('alt-screen-status-depth');
    expect(badge.textContent).toMatch(/depth 2/);
  });

  it('respects the instant transition knob via a data attribute', () => {
    const { rerender } = render(
      <AltScreenStatusBar command="vim" sessionId="s" depth={1} transition="fade" />,
    );
    expect(screen.getByTestId('alt-screen-status-bar').dataset['transition']).toBe('fade');
    rerender(
      <AltScreenStatusBar command="vim" sessionId="s" depth={1} transition="instant" />,
    );
    expect(screen.getByTestId('alt-screen-status-bar').dataset['transition']).toBe('instant');
  });
});
