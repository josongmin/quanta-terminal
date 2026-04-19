/**
 * TUI store — state transition tests.
 *
 * EPIC-H rewrite: the store now mirrors the alt-screen payload from RFC §7.7
 * (active, depth, crashed, transitioning, enteredAt, command, sessionId).
 * Tests cover the behaviour the `useAltScreenMode` hook, the `AltScreenStatusBar`
 * widget, and the byte-level detector installer all rely on:
 *
 *   - enter/exit flip `active` and `depth`.
 *   - enter is depth-cumulative — nested enters keep `active` set and bump
 *     `depth`, matching the RFC's nested-depth counter.
 *   - the outermost transition is the only one that raises `transitioning`.
 *   - reportCrash / clearCrashed manage the ghost-frame reason.
 *   - reset returns to the initial state.
 *   - useAltScreenMode exposes the exact 4-field selector documented in
 *     EPIC-H Appendix A.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAltScreenMode, useTuiStore } from '../model.js';

beforeEach(() => {
  useTuiStore.getState().reset();
  vi.useRealTimers();
});

describe('tui store', () => {
  it('starts inactive with zero depth', () => {
    const s = useTuiStore.getState();
    expect(s.active).toBe(false);
    expect(s.depth).toBe(0);
    expect(s.crashed).toBeNull();
    expect(s.transitioning).toBe(false);
    expect(s.enteredAt).toBeNull();
  });

  it('enter flips active, bumps depth, and records the entry timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T10:00:00Z'));
    useTuiStore.getState().enter({ command: 'vim' });
    const s = useTuiStore.getState();
    expect(s.active).toBe(true);
    expect(s.depth).toBe(1);
    expect(s.enteredAt).toBe(new Date('2026-04-19T10:00:00Z').getTime());
    expect(s.command).toBe('vim');
    // Outer transition raises `transitioning` for the CSS fade.
    expect(s.transitioning).toBe(true);
  });

  it('nested enters bump depth but do not raise transitioning again', () => {
    useTuiStore.getState().enter({ command: 'tmux' });
    useTuiStore.getState().endTransition();
    useTuiStore.getState().enter({ command: 'vim in tmux' });
    const s = useTuiStore.getState();
    expect(s.active).toBe(true);
    expect(s.depth).toBe(2);
    expect(s.command).toBe('vim in tmux');
    // Nested enters must NOT re-animate (RFC §7.7 row 3).
    expect(s.transitioning).toBe(false);
  });

  it('exit decrements depth; only the outer exit flips active off', () => {
    useTuiStore.getState().enter();
    useTuiStore.getState().enter();
    useTuiStore.getState().endTransition();
    useTuiStore.getState().exit();
    expect(useTuiStore.getState().active).toBe(true);
    expect(useTuiStore.getState().depth).toBe(1);
    useTuiStore.getState().exit();
    const s = useTuiStore.getState();
    expect(s.active).toBe(false);
    expect(s.depth).toBe(0);
    expect(s.enteredAt).toBeNull();
    expect(s.transitioning).toBe(true);
  });

  it('stray exit when already inactive is safe', () => {
    useTuiStore.getState().exit();
    const s = useTuiStore.getState();
    expect(s.active).toBe(false);
    expect(s.depth).toBe(0);
  });

  it('reportCrash / clearCrashed manage the ghost-frame reason', () => {
    useTuiStore.getState().enter({ command: 'vim' });
    useTuiStore.getState().reportCrash('signal 9');
    expect(useTuiStore.getState().crashed).toEqual({ reason: 'signal 9' });
    useTuiStore.getState().clearCrashed();
    expect(useTuiStore.getState().crashed).toBeNull();
  });

  it('setLabel updates command without depth changes', () => {
    useTuiStore.getState().enter({ command: 'tmux' });
    useTuiStore.getState().setLabel('vim in tmux');
    expect(useTuiStore.getState().command).toBe('vim in tmux');
    expect(useTuiStore.getState().depth).toBe(1);
  });

  it('endTransition clears the transitioning flag', () => {
    useTuiStore.getState().enter();
    expect(useTuiStore.getState().transitioning).toBe(true);
    useTuiStore.getState().endTransition();
    expect(useTuiStore.getState().transitioning).toBe(false);
  });

  it('reset returns to the initial state', () => {
    useTuiStore.getState().enter();
    useTuiStore.getState().reset();
    const s = useTuiStore.getState();
    expect(s.active).toBe(false);
    expect(s.depth).toBe(0);
    expect(s.enteredAt).toBeNull();
    expect(s.crashed).toBeNull();
  });
});

describe('useAltScreenMode', () => {
  it('exposes the { active, depth, crashed, transitioning } selector tuple', () => {
    const { result } = renderHook(() => useAltScreenMode());
    expect(result.current).toEqual({
      active: false,
      depth: 0,
      crashed: null,
      transitioning: false,
    });
    act(() => {
      useTuiStore.getState().enter();
    });
    expect(result.current.active).toBe(true);
    expect(result.current.depth).toBe(1);
    expect(result.current.transitioning).toBe(true);
    act(() => {
      useTuiStore.getState().reportCrash('signal 9');
    });
    expect(result.current.crashed).toEqual({ reason: 'signal 9' });
  });
});
