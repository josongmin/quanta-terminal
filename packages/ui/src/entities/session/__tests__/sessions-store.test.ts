/**
 * Multi-session collection store tests.
 *
 * Covers the contract the SessionTabs widget and session-tabs actions rely on:
 *   - addSession appends, auto-adopts as active when first.
 *   - addSession is idempotent for duplicate ids.
 *   - removeSession picks the right neighbor as the new active.
 *   - setActive ignores unknown ids.
 *   - patchSession mutates only named fields.
 *   - markExited flips health without touching the active pointer.
 *   - The singular-mirror `useSessionStore` reflects the active entity's
 *     fields, and switches value when the active session swaps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../model.js';
import { bindSessionRemovalHook, useSessionsStore } from '../sessions-store.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;
const C = 'sess-c' as SessionId;

beforeEach(() => {
  useSessionsStore.getState().reset();
});

describe('useSessionsStore — add / remove / active', () => {
  it('addSession appends and auto-adopts as active when first', () => {
    useSessionsStore.getState().addSession({ id: A, shell: '/bin/zsh' });
    const s = useSessionsStore.getState();
    expect(s.order).toEqual([A]);
    expect(s.activeId).toBe(A);
    expect(s.entities[A]?.shell).toBe('/bin/zsh');
  });

  it('addSession does NOT switch active when there is already one', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A });
    coll.addSession({ id: B });
    // Both sessions present, but activeId stays on the first — the lifecycle
    // action layer is responsible for flipping active on createSession.
    expect(useSessionsStore.getState().order).toEqual([A, B]);
    expect(useSessionsStore.getState().activeId).toBe(A);
  });

  it('addSession is idempotent for duplicate ids', () => {
    useSessionsStore.getState().addSession({ id: A, shell: '/bin/zsh' });
    useSessionsStore.getState().addSession({ id: A, shell: '/bin/bash' });
    const s = useSessionsStore.getState();
    expect(s.order).toEqual([A]);
    expect(s.entities[A]?.shell).toBe('/bin/zsh'); // Original shell preserved.
  });

  it('removeSession picks the RIGHT neighbor as the new active', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A });
    coll.addSession({ id: B });
    coll.addSession({ id: C });
    coll.setActive(B);
    coll.removeSession(B);
    expect(useSessionsStore.getState().activeId).toBe(C);
    expect(useSessionsStore.getState().order).toEqual([A, C]);
  });

  it('removeSession falls back to the LEFT neighbor if the removed tab was last', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A });
    coll.addSession({ id: B });
    coll.setActive(B);
    coll.removeSession(B);
    expect(useSessionsStore.getState().activeId).toBe(A);
  });

  it('removeSession leaves activeId null after the last session closes', () => {
    useSessionsStore.getState().addSession({ id: A });
    useSessionsStore.getState().removeSession(A);
    expect(useSessionsStore.getState().activeId).toBeNull();
    expect(useSessionsStore.getState().order).toEqual([]);
  });

  it('setActive is a no-op for unknown ids', () => {
    useSessionsStore.getState().addSession({ id: A });
    useSessionsStore.getState().setActive('nope' as SessionId);
    expect(useSessionsStore.getState().activeId).toBe(A);
  });

  it('patchSession mutates only the named fields of one entity', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A, shell: '/bin/zsh', cwd: '/tmp' });
    coll.addSession({ id: B, shell: '/bin/bash', cwd: '/home' });
    coll.patchSession(A, { cwd: '/var' });
    expect(useSessionsStore.getState().entities[A]?.cwd).toBe('/var');
    expect(useSessionsStore.getState().entities[A]?.shell).toBe('/bin/zsh');
    expect(useSessionsStore.getState().entities[B]?.cwd).toBe('/home');
  });

  it('markExited flips health and stamps exit code without changing active', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A });
    coll.addSession({ id: B });
    coll.setActive(B);
    coll.markExited(A, 137);
    const s = useSessionsStore.getState();
    expect(s.entities[A]?.health).toBe('exited');
    expect(s.entities[A]?.exitCode).toBe(137);
    expect(s.activeId).toBe(B);
  });
});

describe('useSessionStore mirror', () => {
  it('reflects the active session fields after addSession', () => {
    useSessionsStore.getState().addSession({
      id: A,
      shell: '/bin/zsh',
      cwd: '/tmp',
      health: 'ready',
    });
    const s = useSessionStore.getState();
    expect(s.id).toBe(A);
    expect(s.shell).toBe('/bin/zsh');
    expect(s.cwd).toBe('/tmp');
    expect(s.health).toBe('ready');
  });

  it('follows active-swap — fields flip to the new active session', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A, shell: '/bin/zsh', cwd: '/tmp' });
    coll.addSession({ id: B, shell: '/bin/bash', cwd: '/home' });
    coll.setActive(B);
    const s = useSessionStore.getState();
    expect(s.id).toBe(B);
    expect(s.shell).toBe('/bin/bash');
    expect(s.cwd).toBe('/home');
  });

  it('legacy setSession with a new id seeds AND adopts as active', () => {
    useSessionStore.getState().setSession({
      id: A,
      shell: '/bin/zsh',
      cwd: '/tmp',
      health: 'ready',
    });
    expect(useSessionsStore.getState().activeId).toBe(A);
    expect(useSessionStore.getState().shell).toBe('/bin/zsh');
  });

  it('legacy setSession with fields only (no id) patches the current active', () => {
    useSessionsStore.getState().addSession({ id: A, shell: '/bin/zsh' });
    useSessionStore.getState().setSession({ cwd: '/new' });
    expect(useSessionsStore.getState().entities[A]?.cwd).toBe('/new');
  });

  it('legacy markExited forwards to the active session', () => {
    useSessionsStore.getState().addSession({ id: A });
    useSessionStore.getState().markExited(42);
    expect(useSessionsStore.getState().entities[A]?.health).toBe('exited');
    expect(useSessionsStore.getState().entities[A]?.exitCode).toBe(42);
  });
});

describe('reorderSessions', () => {
  it('moves a session from one index to another', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A });
    coll.addSession({ id: B });
    coll.addSession({ id: C });
    coll.reorderSessions(0, 2);
    expect(useSessionsStore.getState().order).toEqual([B, C, A]);
  });

  it('supports moving backwards', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A });
    coll.addSession({ id: B });
    coll.addSession({ id: C });
    coll.reorderSessions(2, 0);
    expect(useSessionsStore.getState().order).toEqual([C, A, B]);
  });

  it('preserves activeId across a reorder', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A });
    coll.addSession({ id: B });
    coll.setActive(B);
    coll.reorderSessions(1, 0);
    expect(useSessionsStore.getState().activeId).toBe(B);
    expect(useSessionsStore.getState().order).toEqual([B, A]);
  });

  it('is a no-op for out-of-range indices', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A });
    coll.addSession({ id: B });
    const before = useSessionsStore.getState().order;
    coll.reorderSessions(-1, 0);
    coll.reorderSessions(0, 99);
    expect(useSessionsStore.getState().order).toEqual(before);
  });

  it('is a no-op when fromIndex === toIndex', () => {
    const coll = useSessionsStore.getState();
    coll.addSession({ id: A });
    coll.addSession({ id: B });
    const ref = useSessionsStore.getState();
    coll.reorderSessions(1, 1);
    // Same reference — no re-render would fire.
    expect(useSessionsStore.getState()).toBe(ref);
  });
});

describe('audit P1 (fix 3): bindSessionRemovalHook', () => {
  let unbind: (() => void) | undefined;
  afterEach(() => {
    if (unbind) unbind();
    unbind = undefined;
  });

  it('invokes the hook with the removed id AFTER the state commit', () => {
    const seenWhenCalled: Array<{ id: SessionId; stillPresent: boolean }> = [];
    unbind = bindSessionRemovalHook((id) => {
      const stillPresent = Boolean(useSessionsStore.getState().entities[id]);
      seenWhenCalled.push({ id, stillPresent });
    });
    useSessionsStore.getState().addSession({ id: A });
    useSessionsStore.getState().removeSession(A);
    expect(seenWhenCalled).toEqual([{ id: A, stillPresent: false }]);
  });

  it('does NOT invoke the hook when removeSession is a no-op (unknown id)', () => {
    const spy = vi.fn();
    unbind = bindSessionRemovalHook(spy);
    useSessionsStore.getState().removeSession(A); // never added
    expect(spy).not.toHaveBeenCalled();
  });

  it('is a no-op (no crash) when no hook is bound', () => {
    // Deliberately do NOT bind — this is the pre-wiring state some tests hit.
    useSessionsStore.getState().addSession({ id: A });
    expect(() => useSessionsStore.getState().removeSession(A)).not.toThrow();
  });
});
