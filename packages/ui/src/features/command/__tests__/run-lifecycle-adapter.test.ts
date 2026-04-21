/**
 * run-lifecycle-adapter — boundary events → Run lifecycle.
 *
 * Exercises the flag-gating contract, the prompt_start → running → command_end
 * happy path, out-of-order / missing-boundary handling, adapter replacement
 * semantics, and dispose-time cancellation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __getCurrentRunIdForTests,
  __hasAdapterForTests,
  __resetRunLifecycleAdaptersForTests,
  emitBoundaryEvent,
  installRunLifecycleAdapter,
} from '../run-lifecycle-adapter.js';
import { useRunsStore } from '../../../entities/run/index.js';
import {
  resetFeatureFlags,
  setFeatureFlag,
} from '../../../shared/config/feature-flags.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const SESS = 'sess-adapter' as SessionId;
const OTHER = 'sess-other' as SessionId;

beforeEach(() => {
  resetFeatureFlags();
  __resetRunLifecycleAdaptersForTests();
  useRunsStore.getState().reset();
});

afterEach(() => {
  resetFeatureFlags();
  __resetRunLifecycleAdaptersForTests();
  useRunsStore.getState().reset();
});

describe('run-lifecycle-adapter — flag gating', () => {
  it('install is a no-op when flag.runEntity is OFF (default)', () => {
    const handle = installRunLifecycleAdapter(SESS);
    expect(__hasAdapterForTests(SESS)).toBe(false);
    // Dispose on a no-op handle is safe.
    handle.dispose();
  });

  it('emitBoundaryEvent is a no-op when flag.runEntity is OFF', () => {
    // Install-while-off produces no adapter.
    installRunLifecycleAdapter(SESS);
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: SESS,
      command: 'ls',
    });
    expect(useRunsStore.getState().order).toEqual([]);
  });

  it('install registers an adapter once flag.runEntity is ON', () => {
    setFeatureFlag('runEntity', true);
    installRunLifecycleAdapter(SESS);
    expect(__hasAdapterForTests(SESS)).toBe(true);
  });
});

describe('run-lifecycle-adapter — prompt_start → command_end', () => {
  beforeEach(() => {
    setFeatureFlag('runEntity', true);
  });

  it('prompt_start creates a shell Run in running state and sets it active', () => {
    installRunLifecycleAdapter(SESS);
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: SESS,
      command: 'echo hi',
      cwd: '/tmp',
    });
    const s = useRunsStore.getState();
    expect(s.order.length).toBe(1);
    const runId = s.order[0]!;
    const run = s.runs[runId]!;
    expect(run.state).toBe('running');
    expect(run.type).toBe('shell');
    expect(run.command).toBe('echo hi');
    expect(run.cwd).toBe('/tmp');
    expect(s.activeRunId).toBe(runId);
    expect(__getCurrentRunIdForTests(SESS)).toBe(runId);
  });

  it('command_end completes the active Run with the given exit code', () => {
    installRunLifecycleAdapter(SESS);
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: SESS,
      command: 'false',
    });
    const runId = __getCurrentRunIdForTests(SESS)!;
    emitBoundaryEvent({ kind: 'command_end', sessionId: SESS, exitCode: 1 });
    const run = useRunsStore.getState().runs[runId]!;
    expect(run.state).toBe('completed');
    expect(run.exitCode).toBe(1);
    expect(__getCurrentRunIdForTests(SESS)).toBeNull();
  });

  it('a second prompt_start with no intervening end cancels the previous Run', () => {
    installRunLifecycleAdapter(SESS);
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: SESS,
      command: 'first',
    });
    const first = __getCurrentRunIdForTests(SESS)!;
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: SESS,
      command: 'second',
    });
    const second = __getCurrentRunIdForTests(SESS)!;
    expect(second).not.toBe(first);
    const firstRun = useRunsStore.getState().runs[first]!;
    expect(firstRun.state).toBe('canceled');
    expect(firstRun.metadata.cancelReason).toBe('superseded-by-next-prompt');
    expect(useRunsStore.getState().runs[second]?.state).toBe('running');
  });

  it('command_end without a prior prompt_start is dropped silently', () => {
    installRunLifecycleAdapter(SESS);
    emitBoundaryEvent({ kind: 'command_end', sessionId: SESS, exitCode: 0 });
    expect(useRunsStore.getState().order).toEqual([]);
  });

  it('events for an unregistered session are dropped', () => {
    installRunLifecycleAdapter(SESS);
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: OTHER,
      command: 'ls',
    });
    expect(useRunsStore.getState().order).toEqual([]);
  });

  it('two sessions track their own in-flight runs independently', () => {
    installRunLifecycleAdapter(SESS);
    installRunLifecycleAdapter(OTHER);
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: SESS,
      command: 'a',
    });
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: OTHER,
      command: 'b',
    });
    const aId = __getCurrentRunIdForTests(SESS)!;
    const bId = __getCurrentRunIdForTests(OTHER)!;
    expect(aId).not.toBe(bId);
    emitBoundaryEvent({ kind: 'command_end', sessionId: SESS, exitCode: 0 });
    expect(useRunsStore.getState().runs[aId]?.state).toBe('completed');
    expect(useRunsStore.getState().runs[bId]?.state).toBe('running');
  });

  it('dispose cancels the in-flight Run with reason=adapter-disposed', () => {
    const handle = installRunLifecycleAdapter(SESS);
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: SESS,
      command: 'sleep 9',
    });
    const runId = __getCurrentRunIdForTests(SESS)!;
    handle.dispose();
    const run = useRunsStore.getState().runs[runId]!;
    expect(run.state).toBe('canceled');
    expect(run.metadata.cancelReason).toBe('adapter-disposed');
    expect(__hasAdapterForTests(SESS)).toBe(false);
  });

  it('confidence and semanticRange flow from event into the Run', () => {
    installRunLifecycleAdapter(SESS);
    emitBoundaryEvent({
      kind: 'prompt_start',
      sessionId: SESS,
      command: 'echo',
      confidence: 0.4,
      semanticRange: {
        promptStartRow: 1,
        commandStartRow: 1,
        outputStartRow: 2,
        outputEndRow: 3,
      },
    });
    const runId = __getCurrentRunIdForTests(SESS)!;
    const run = useRunsStore.getState().runs[runId]!;
    expect(run.confidence).toBe(0.4);
    expect(run.semanticRange?.outputEndRow).toBe(3);
  });
});
