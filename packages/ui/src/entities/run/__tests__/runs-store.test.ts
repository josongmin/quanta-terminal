/**
 * Run store — lifecycle, DAG, selectors, reset.
 *
 * Covers the 15-test minimum laid out in Plan 0005 P2-A.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getChildrenFromState,
  isTerminalRunState,
  useRunsStore,
  type RunId,
  type RunPatch,
  type RunState,
} from '../index.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;

beforeEach(() => {
  useRunsStore.getState().reset();
});

describe('runs-store — startRun', () => {
  it('startRun appends an id to order and seeds a pending Run by default', () => {
    const id = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    const s = useRunsStore.getState();
    expect(s.order).toEqual([id]);
    const r = s.runs[id]!;
    expect(r.id).toBe(id);
    expect(r.state).toBe('pending');
    expect(r.type).toBe('shell');
    expect(r.parentRunId).toBeNull();
    expect(r.command).toBeNull();
    expect(r.cwd).toBe('');
    expect(r.metadata).toEqual({});
  });

  it('startRun honors initialState override (running)', () => {
    const id = useRunsStore.getState().startRun({
      sessionId: A,
      type: 'shell',
      initialState: 'running',
    });
    expect(useRunsStore.getState().runs[id]?.state).toBe('running');
  });

  it('startRun sets the new Run as active', () => {
    const id = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    expect(useRunsStore.getState().activeRunId).toBe(id);
  });

  it('startRun with parentRunId wires the DAG pointer', () => {
    const parent = useRunsStore
      .getState()
      .startRun({ sessionId: A, type: 'shell', command: 'make' });
    const child = useRunsStore.getState().startRun({
      sessionId: A,
      type: 'subrun',
      parentRunId: parent,
      command: 'cargo build',
    });
    expect(useRunsStore.getState().runs[child]?.parentRunId).toBe(parent);
  });

  it('startRun yields unique ids for successive calls', () => {
    const a = useRunsStore.getState().startRun({ sessionId: A, type: 'task' });
    const b = useRunsStore.getState().startRun({ sessionId: A, type: 'task' });
    expect(a).not.toBe(b);
    expect(useRunsStore.getState().order).toEqual([a, b]);
  });
});

describe('runs-store — completeRun / cancelRun', () => {
  it('completeRun stamps exitCode, completedAt and sets state=completed', () => {
    const id = useRunsStore
      .getState()
      .startRun({ sessionId: A, type: 'shell', initialState: 'running' });
    useRunsStore.getState().completeRun(id, 0);
    const r = useRunsStore.getState().runs[id]!;
    expect(r.state).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.completedAt).not.toBeNull();
  });

  it('completeRun clears activeRunId when it points at the completed Run', () => {
    const id = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    expect(useRunsStore.getState().activeRunId).toBe(id);
    useRunsStore.getState().completeRun(id, 0);
    expect(useRunsStore.getState().activeRunId).toBeNull();
  });

  it('completeRun on a terminal Run is a no-op', () => {
    const id = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    useRunsStore.getState().completeRun(id, 0);
    const before = useRunsStore.getState().runs[id]!;
    useRunsStore.getState().completeRun(id, 42);
    const after = useRunsStore.getState().runs[id]!;
    expect(after).toBe(before);
    expect(after.exitCode).toBe(0);
  });

  it('cancelRun flips state to canceled and stashes the reason in metadata', () => {
    const id = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    useRunsStore.getState().cancelRun(id, 'user-ctrl-c');
    const r = useRunsStore.getState().runs[id]!;
    expect(r.state).toBe('canceled');
    expect(r.metadata.cancelReason).toBe('user-ctrl-c');
    expect(r.completedAt).not.toBeNull();
  });

  it('cancelRun without a reason keeps metadata pristine', () => {
    const id = useRunsStore.getState().startRun({
      sessionId: A,
      type: 'agent',
      metadata: { model: 'claude-3' },
    });
    useRunsStore.getState().cancelRun(id);
    const r = useRunsStore.getState().runs[id]!;
    expect(r.state).toBe('canceled');
    expect(r.metadata.model).toBe('claude-3');
    expect(r.metadata.cancelReason).toBeUndefined();
  });

  it('cancelRun on a terminal Run is a no-op', () => {
    const id = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    useRunsStore.getState().completeRun(id, 0);
    const before = useRunsStore.getState().runs[id]!;
    useRunsStore.getState().cancelRun(id, 'too late');
    expect(useRunsStore.getState().runs[id]!).toBe(before);
  });
});

describe('runs-store — updateRun', () => {
  it('updateRun merges telemetry fields on a live Run', () => {
    const id = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    useRunsStore.getState().updateRun(id, {
      resourceUsage: { cpuMs: 120, rssPeakKb: 4096, ioBytes: 256 },
      confidence: 0.6,
    });
    const r = useRunsStore.getState().runs[id]!;
    expect(r.resourceUsage?.cpuMs).toBe(120);
    expect(r.confidence).toBe(0.6);
  });

  it('updateRun refuses to mutate identity-bearing fields (id/type/sessionId/parentRunId/startedAt)', () => {
    const id = useRunsStore.getState().startRun({
      sessionId: A,
      type: 'shell',
      command: 'ls',
    });
    const before = useRunsStore.getState().runs[id]!;
    // Cast through `unknown` — the typed RunPatch deliberately omits these
    // fields, but we exercise the runtime guard for callers who reach the
    // action via an unsafe boundary (event-replay, adapters that spread a
    // whole Run back in). The store must not trust the patch shape.
    const evilPatch = {
      id: 'hijack' as RunId,
      type: 'agent',
      sessionId: B,
      parentRunId: 'someone-else' as RunId,
      startedAt: 99,
    } as unknown as RunPatch;
    useRunsStore.getState().updateRun(id, evilPatch);
    const after = useRunsStore.getState().runs[id]!;
    expect(after.id).toBe(before.id);
    expect(after.type).toBe(before.type);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.parentRunId).toBe(before.parentRunId);
    expect(after.startedAt).toBe(before.startedAt);
  });

  it('updateRun on a terminal Run is a no-op', () => {
    const id = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    useRunsStore.getState().completeRun(id, 0);
    const before = useRunsStore.getState().runs[id]!;
    useRunsStore.getState().updateRun(id, { confidence: 0.1 });
    expect(useRunsStore.getState().runs[id]!).toBe(before);
  });

  it('updateRun on an unknown id is a no-op', () => {
    const snap = useRunsStore.getState();
    useRunsStore.getState().updateRun('no-such' as RunId, { confidence: 0.5 });
    expect(useRunsStore.getState()).toBe(snap);
  });
});

describe('runs-store — DAG / parent-child', () => {
  it('getChildren returns subruns in insertion order', () => {
    const parent = useRunsStore
      .getState()
      .startRun({ sessionId: A, type: 'shell', command: 'pipeline' });
    const c1 = useRunsStore
      .getState()
      .startRun({ sessionId: A, type: 'subrun', parentRunId: parent, command: 'step1' });
    const c2 = useRunsStore
      .getState()
      .startRun({ sessionId: A, type: 'subrun', parentRunId: parent, command: 'step2' });
    const kids = useRunsStore.getState().getChildren(parent);
    expect(kids.map((k) => k.id)).toEqual([c1, c2]);
  });

  it('getChildren returns empty when there are none', () => {
    const parent = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    expect(useRunsStore.getState().getChildren(parent)).toEqual([]);
  });

  it('getChildrenFromState is equivalent to the live getChildren', () => {
    const parent = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    const c1 = useRunsStore
      .getState()
      .startRun({ sessionId: A, type: 'subrun', parentRunId: parent });
    const viaState = getChildrenFromState(useRunsStore.getState(), parent);
    expect(viaState.map((k) => k.id)).toEqual([c1]);
  });
});

describe('runs-store — setActive', () => {
  it('setActive(null) clears the active pointer', () => {
    useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    useRunsStore.getState().setActive(null);
    expect(useRunsStore.getState().activeRunId).toBeNull();
  });

  it('setActive with an unknown id is a no-op', () => {
    const id = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    useRunsStore.getState().setActive('nope' as RunId);
    expect(useRunsStore.getState().activeRunId).toBe(id);
  });

  it('setActive with a known id swaps the active pointer', () => {
    const a = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    const b = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    // startRun(b) auto-activated b; flip back to a.
    useRunsStore.getState().setActive(a);
    expect(useRunsStore.getState().activeRunId).toBe(a);
    expect(useRunsStore.getState().runs[b]?.state).toBe('pending');
  });
});

describe('runs-store — reset and selectors', () => {
  it('reset wipes runs/order/activeRunId', () => {
    useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    useRunsStore.getState().reset();
    const s = useRunsStore.getState();
    expect(s.runs).toEqual({});
    expect(s.order).toEqual([]);
    expect(s.activeRunId).toBeNull();
  });

  it('isTerminalRunState matches the store invariant', () => {
    // Sanity that the store uses the same predicate as consumers — a regression
    // here means the store could accept mutations on terminal Runs.
    const nonTerminal: RunState[] = ['pending', 'running', 'suspended'];
    const terminal: RunState[] = ['completed', 'failed', 'canceled', 'killed'];
    for (const s of nonTerminal) expect(isTerminalRunState(s)).toBe(false);
    for (const s of terminal) expect(isTerminalRunState(s)).toBe(true);
  });

  it('concurrent sessions do not see each others runs via order', () => {
    const aId = useRunsStore.getState().startRun({ sessionId: A, type: 'shell' });
    const bId = useRunsStore.getState().startRun({ sessionId: B, type: 'shell' });
    const s = useRunsStore.getState();
    expect(s.order).toEqual([aId, bId]);
    const aRuns = Object.values(s.runs).filter((r) => r.sessionId === A);
    const bRuns = Object.values(s.runs).filter((r) => r.sessionId === B);
    expect(aRuns.map((r) => r.id)).toEqual([aId]);
    expect(bRuns.map((r) => r.id)).toEqual([bId]);
  });
});
