/**
 * `useModeStack` (production wiring) — Plan 0005 P1-D wave 1.
 *
 * Pins that the real hook subscribes to `useModeStackStore` and projects
 * abstract ModeStack layers into the composite registry kinds consumed by
 * `GhostHint`. The P1-D installer lives in `features/mode-stack/install.ts`
 * and is exercised end-to-end in its own integration test; here we focus
 * on the projection rules:
 *
 *   - a `pager` layer with `hints.pagerApp='less'` → `pager_less`
 *   - a `repl`  layer with `hints.replShell='python'` → `repl_python`
 *   - a `tui` layer alone → `tui` (no app hint; GhostHint falls through)
 *   - a `nested-shell` layer → `shell_nested`
 *   - `shell` root never surfaces in the projected snapshot
 *
 * The live rendering assertions (hint text, data-dismissed semantics) are
 * already covered by `GhostHint.test.tsx` against an injected stack hook;
 * this suite stays narrow to avoid duplicating that matrix.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useModeStackStore } from '../../../features/mode-stack/index.js';
import { GhostHint } from '../GhostHint.js';
import { useModeStack } from '../useModeStack.js';

describe('useModeStack (production hook wired to the real store)', () => {
  beforeEach(() => {
    useModeStackStore.getState().reset();
  });
  afterEach(() => {
    useModeStackStore.getState().reset();
  });

  it('projects a pager layer into `pager_less` via GhostHint', () => {
    act(() => {
      useModeStackStore.getState().push({
        kind: 'pager',
        hints: { pagerApp: 'less' },
        inputPolicy: 'intercept_prefix',
        mousePolicy: 'dropped',
        renderHint: 'ghost',
      });
    });
    act(() => {
      render(<GhostHint stackHook={useModeStack} />);
    });
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.dataset['kind']).toBe('pager_less');
    expect(pill.textContent).toMatch(/press q to quit/);
  });

  it('projects a repl/python layer into `repl_python`', () => {
    act(() => {
      useModeStackStore.getState().push({
        kind: 'repl',
        hints: { replShell: 'python' },
        inputPolicy: 'line_edit',
        mousePolicy: 'dropped',
        renderHint: 'ghost',
      });
    });
    act(() => {
      render(<GhostHint stackHook={useModeStack} />);
    });
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.dataset['kind']).toBe('repl_python');
    expect(pill.textContent).toMatch(/exit\(\) or \^D/);
  });

  it('projects a nested-shell layer into `shell_nested`', () => {
    act(() => {
      useModeStackStore.getState().push({
        kind: 'nested-shell',
        inputPolicy: 'passthrough',
        mousePolicy: 'outermost_wins',
        renderHint: 'chrome',
      });
    });
    act(() => {
      render(<GhostHint stackHook={useModeStack} />);
    });
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.dataset['kind']).toBe('shell_nested');
  });

  it('projects a multiplexer layer into `multiplexer_tmux`', () => {
    act(() => {
      useModeStackStore.getState().push({
        kind: 'multiplexer',
        hints: { multiplexer: 'tmux' },
        inputPolicy: 'intercept_prefix',
        mousePolicy: 'outermost_wins',
        renderHint: 'chrome',
      });
    });
    act(() => {
      render(<GhostHint stackHook={useModeStack} />);
    });
    const pill = screen.getByTestId('ghost-hint');
    expect(pill.dataset['kind']).toBe('multiplexer_tmux');
  });

  it('shell root alone surfaces no hint', () => {
    act(() => {
      render(<GhostHint stackHook={useModeStack} />);
    });
    expect(screen.queryByTestId('ghost-hint')).toBeNull();
  });
});
