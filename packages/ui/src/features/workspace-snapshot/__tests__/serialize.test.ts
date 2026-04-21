/**
 * Unit tests for captureSnapshot / restoreSnapshot (pure helpers).
 *
 * These tests do NOT touch the IDB layer — they feed stub state into
 * captureSnapshot and stub createSession into restoreSnapshot, asserting the
 * snapshot is well-formed and that restore calls createSession for every
 * SnapSession while rehydrating the pane tree and filter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureSnapshot,
  restoreSnapshot,
  AUTO_SNAPSHOT_ID,
  AUTO_SNAPSHOT_NAME,
  WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
} from '../index.js';
import { useSessionsStore } from '../../../entities/session/index.js';
import { usePaneStore } from '../../../entities/pane/index.js';
import { useBlockFilterStore } from '../../../entities/block-filter/index.js';
import type { SessionId } from '../../../shared/types/generated/index.js';
import type { CreateSessionResult } from '../../session-tabs/index.js';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;
const NEW_A = 'new-sess-a' as SessionId;
const NEW_B = 'new-sess-b' as SessionId;

beforeEach(() => {
  useSessionsStore.getState().reset();
  usePaneStore.getState().reset();
  useBlockFilterStore.getState().clear();
});

afterEach(() => {
  useSessionsStore.getState().reset();
  usePaneStore.getState().reset();
  useBlockFilterStore.getState().clear();
});

describe('captureSnapshot', () => {
  it('produces a well-formed snapshot over the current stores', () => {
    useSessionsStore.getState().addSession({ id: A, shell: '/bin/zsh', cwd: '/tmp' });
    useSessionsStore.getState().addSession({ id: B, shell: '/bin/bash', cwd: '/var' });
    usePaneStore.getState().setRoot(A);
    usePaneStore.getState().splitActive('horizontal', B);
    useBlockFilterStore.getState().addTag('deploy');
    useBlockFilterStore.getState().setMode('all');

    const snap = captureSnapshot({ name: 'deploy flow', createdAt: 1234 });

    expect(snap.name).toBe('deploy flow');
    expect(snap.createdAt).toBe(1234);
    expect(snap.sessions).toHaveLength(2);
    expect(snap.sessions[0]?.id).toBe(A);
    expect(snap.sessions[0]?.shell).toBe('/bin/zsh');
    expect(snap.sessions[0]?.cwd).toBe('/tmp');
    expect(snap.sessions[1]?.id).toBe(B);
    expect(snap.tabOrder).toEqual([A, B]);
    expect(snap.activeTags).toEqual(['deploy']);
    expect(snap.filterMode).toBe('all');
    expect(snap.paneTree.version).toBe(WORKSPACE_SNAPSHOT_SCHEMA_VERSION);
    expect(snap.paneTree.root).toMatchObject({
      kind: 'split',
      dir: 'horizontal',
      left: { kind: 'leaf', sessionId: A },
      right: { kind: 'leaf', sessionId: B },
    });
  });

  it('defaults name to the auto-slot and stamps the reserved id', () => {
    const snap = captureSnapshot();
    expect(snap.name).toBe(AUTO_SNAPSHOT_NAME);
    expect(snap.id).toBe(AUTO_SNAPSHOT_ID);
  });

  it('accepts stub stores without touching the live singletons', () => {
    const snap = captureSnapshot({
      name: 'test',
      sessions: {
        order: [A],
        entities: {
          [A]: {
            id: A,
            shell: '/bin/zsh',
            cwd: '/home',
            cwdSource: 'launch',
            shellIntegration: 'installed',
            health: 'ready',
            exitCode: null,
          },
        } as never,
      },
      pane: { root: { kind: 'leaf', sessionId: A }, focusPath: [], zoomedPaneId: null },
      filter: { activeTags: new Set(['bug']), mode: 'any' },
    });
    // Live stores are untouched.
    expect(useSessionsStore.getState().order).toHaveLength(0);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.activeTags).toEqual(['bug']);
  });
});

describe('restoreSnapshot', () => {
  it('closes existing sessions then calls createSession per snap session', async () => {
    // Seed two live sessions that will be torn down.
    useSessionsStore.getState().addSession({ id: 'old-a' as SessionId });
    useSessionsStore.getState().addSession({ id: 'old-b' as SessionId });

    const closeCalls: string[] = [];
    let spawnCount = 0;

    const createImpl = vi.fn(async (): Promise<CreateSessionResult> => {
      spawnCount += 1;
      const newId = (spawnCount === 1 ? NEW_A : NEW_B) as SessionId;
      useSessionsStore.getState().addSession({ id: newId });
      return {
        sessionId: newId,
        // Fake ConnectedSession is structurally inert — restore doesn't use it.
        connection: {} as never,
      };
    });
    const closeImpl = vi.fn(async (id: SessionId) => {
      closeCalls.push(id);
      useSessionsStore.getState().removeSession(id);
    });

    const snap = captureSnapshot({
      name: 'restore test',
      sessions: {
        order: [A, B],
        entities: {
          [A]: {
            id: A,
            shell: '/bin/zsh',
            cwd: '/w',
            cwdSource: 'launch',
            shellIntegration: 'installed',
            health: 'ready',
            exitCode: null,
          },
          [B]: {
            id: B,
            shell: '/bin/bash',
            cwd: '/y',
            cwdSource: 'launch',
            shellIntegration: 'installed',
            health: 'ready',
            exitCode: null,
          },
        } as never,
      },
      pane: {
        root: {
          kind: 'split',
          dir: 'horizontal',
          ratio: 0.5,
          left: { kind: 'leaf', sessionId: A },
          right: { kind: 'leaf', sessionId: B },
        },
        focusPath: [1],
        zoomedPaneId: null,
      },
      filter: { activeTags: new Set(['x', 'y']), mode: 'all' },
    });

    const idMap = await restoreSnapshot({
      snapshot: snap,
      createSessionImpl: createImpl,
      closeSessionImpl: closeImpl,
    });

    // Old sessions closed, then two spawns happened.
    expect(closeCalls.sort()).toEqual(['old-a', 'old-b']);
    expect(createImpl).toHaveBeenCalledTimes(2);
    expect(idMap.get(A)).toBe(NEW_A);
    expect(idMap.get(B)).toBe(NEW_B);

    // Pane tree replayed with remapped ids.
    const pane = usePaneStore.getState();
    expect(pane.root).toMatchObject({
      kind: 'split',
      left: { kind: 'leaf', sessionId: NEW_A },
      right: { kind: 'leaf', sessionId: NEW_B },
    });
    expect(pane.focusPath).toEqual([1]);

    // Filter rehydrated.
    const filter = useBlockFilterStore.getState();
    expect([...filter.activeTags].sort()).toEqual(['x', 'y']);
    expect(filter.mode).toBe('all');
  });

  it('collapses the pane tree when a session id fails to remap', async () => {
    const snap = captureSnapshot({
      name: 'collapse',
      sessions: {
        order: [A],
        entities: {
          [A]: {
            id: A,
            shell: '',
            cwd: '',
            cwdSource: 'launch',
            shellIntegration: 'missing',
            health: 'ready',
            exitCode: null,
          },
        } as never,
      },
      pane: {
        root: {
          kind: 'split',
          dir: 'vertical',
          ratio: 0.5,
          left: { kind: 'leaf', sessionId: A },
          right: { kind: 'leaf', sessionId: B }, // not in snapshot sessions
        },
        focusPath: [],
        zoomedPaneId: null,
      },
      filter: { activeTags: new Set(), mode: 'any' },
    });
    // Snapshot only carries session A, so B's leaf will be dropped.
    await restoreSnapshot({
      snapshot: { ...snap, sessions: snap.sessions.filter((s) => s.id === A) },
      createSessionImpl: vi.fn(async () => {
        useSessionsStore.getState().addSession({ id: NEW_A });
        return { sessionId: NEW_A, connection: {} as never };
      }),
      closeSessionImpl: vi.fn(async () => {}),
    });
    const root = usePaneStore.getState().root;
    expect(root).toEqual({ kind: 'leaf', sessionId: NEW_A });
  });
});
