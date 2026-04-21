/**
 * Unit tests for validateSnapshot — the schema-validation guard that sits in
 * front of IDB deserialization so corrupt or malicious entries are safely
 * discarded rather than trusted directly.
 */

import { describe, expect, it } from 'vitest';
import {
  validateSnapshot,
  MAX_SESSIONS,
} from '../serialize.js';
import { WORKSPACE_SNAPSHOT_SCHEMA_VERSION } from '../model.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown> = {}) {
  return { id: 'sess-1', shell: '/bin/zsh', cwd: '/home', ...overrides };
}

function makeValidRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap_001',
    name: 'test',
    createdAt: 1_700_000_000,
    filterMode: 'any',
    sessions: [makeSession()],
    activeTags: ['deploy'],
    tabOrder: ['sess-1'],
    paneTree: {
      version: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
      root: { kind: 'leaf', sessionId: 'sess-1' },
      focusPath: [],
      zoomedPaneId: null,
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('validateSnapshot', () => {
  it('returns null for null input', () => {
    expect(validateSnapshot(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(validateSnapshot(undefined)).toBeNull();
  });

  it('returns null for a primitive string', () => {
    expect(validateSnapshot('{"id":"x"}')).toBeNull();
  });

  it('returns null for an empty object', () => {
    expect(validateSnapshot({})).toBeNull();
  });

  it('passes a valid snapshot', () => {
    const raw = makeValidRaw();
    expect(validateSnapshot(raw)).not.toBeNull();
    // The returned value is the same object (typed as WorkspaceSnapshot).
    expect(validateSnapshot(raw)).toBe(raw);
  });

  it('returns null when sessions array has 65 entries (over MAX_SESSIONS cap)', () => {
    const sessions = Array.from({ length: MAX_SESSIONS + 1 }, (_, i) =>
      makeSession({ id: `sess-${i}` }),
    );
    expect(validateSnapshot(makeValidRaw({ sessions }))).toBeNull();
  });

  it('passes a snapshot with exactly MAX_SESSIONS sessions', () => {
    const sessions = Array.from({ length: MAX_SESSIONS }, (_, i) =>
      makeSession({ id: `sess-${i}` }),
    );
    const tabOrder = sessions.map((s) => s.id);
    expect(validateSnapshot(makeValidRaw({ sessions, tabOrder }))).not.toBeNull();
  });

  it('returns null for a pane tree 33 levels deep (over depth limit)', () => {
    // Build a left-biased split tree with 33 levels of nesting.
    type NodeShape = { kind: string; sessionId?: string; left?: NodeShape; right?: NodeShape; dir?: string; ratio?: number };
    let node: NodeShape = { kind: 'leaf', sessionId: 'sess-1' };
    for (let i = 0; i < 33; i++) {
      node = {
        kind: 'split',
        dir: 'horizontal',
        ratio: 0.5,
        left: node,
        right: { kind: 'leaf', sessionId: 'sess-1' },
      };
    }
    expect(
      validateSnapshot(makeValidRaw({ paneTree: { version: WORKSPACE_SNAPSHOT_SCHEMA_VERSION, root: node, focusPath: [], zoomedPaneId: null } })),
    ).toBeNull();
  });

  it('passes a pane tree with exactly 32 levels of nesting', () => {
    type NodeShape = { kind: string; sessionId?: string; left?: NodeShape; right?: NodeShape; dir?: string; ratio?: number };
    let node: NodeShape = { kind: 'leaf', sessionId: 'sess-1' };
    for (let i = 0; i < 32; i++) {
      node = {
        kind: 'split',
        dir: 'vertical',
        ratio: 0.5,
        left: node,
        right: { kind: 'leaf', sessionId: 'sess-1' },
      };
    }
    expect(
      validateSnapshot(makeValidRaw({ paneTree: { version: WORKSPACE_SNAPSHOT_SCHEMA_VERSION, root: node, focusPath: [], zoomedPaneId: null } })),
    ).not.toBeNull();
  });

  it('returns null when sessions field is missing', () => {
    const raw = makeValidRaw();
    const { sessions: _omit, ...withoutSessions } = raw as Record<string, unknown>;
    expect(validateSnapshot(withoutSessions)).toBeNull();
  });

  it('returns null when sessions is not an array', () => {
    expect(validateSnapshot(makeValidRaw({ sessions: 'oops' }))).toBeNull();
  });

  it('returns null when paneTree.version is wrong', () => {
    expect(
      validateSnapshot(
        makeValidRaw({
          paneTree: {
            version: WORKSPACE_SNAPSHOT_SCHEMA_VERSION + 99,
            root: null,
            focusPath: [],
            zoomedPaneId: null,
          },
        }),
      ),
    ).toBeNull();
  });

  it('returns null when a session entry is missing the shell field', () => {
    const sessions = [{ id: 'sess-1', cwd: '/home' }]; // shell missing
    expect(validateSnapshot(makeValidRaw({ sessions }))).toBeNull();
  });

  it('returns null when a session entry is missing the cwd field', () => {
    const sessions = [{ id: 'sess-1', shell: '/bin/zsh' }]; // cwd missing
    expect(validateSnapshot(makeValidRaw({ sessions }))).toBeNull();
  });

  it('returns null when activeTags has more than 100 entries', () => {
    const activeTags = Array.from({ length: 101 }, (_, i) => `tag-${i}`);
    expect(validateSnapshot(makeValidRaw({ activeTags }))).toBeNull();
  });

  it('passes a null paneTree root (no panes open)', () => {
    expect(
      validateSnapshot(
        makeValidRaw({
          paneTree: {
            version: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
            root: null,
            focusPath: [],
            zoomedPaneId: null,
          },
        }),
      ),
    ).not.toBeNull();
  });
});
