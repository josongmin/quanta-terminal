/**
 * AgentRunner — lifecycle, cancellation, stream emission, completion.
 *
 * The mock runner is driven by an injectable `ManualScheduler` so we can
 * step through each synthetic chunk deterministically (no setTimeout
 * races, no microtask flush ambiguity).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindAgentRunner,
  createManualScheduler,
  createMockAgentRunner,
  getAgentRunner,
  MOCK_RUN_CHUNK_COUNT,
  mockChunksForSpec,
  resetAgentRunnerForTests,
  type AgentAction,
  type AgentRunSpec,
} from '../index.js';
import { useRunsStore } from '../runs-store.js';

function buildSpec(overrides: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    type: 'agent',
    tool: 'git_log',
    args: { n: 5 },
    source: 'ai',
    confidence: 0.9,
    ...overrides,
  };
}

beforeEach(() => {
  useRunsStore.getState().resetAll();
  resetAgentRunnerForTests();
});

afterEach(() => {
  useRunsStore.getState().resetAll();
  resetAgentRunnerForTests();
});

describe('createMockAgentRunner — lifecycle', () => {
  it('creates a run in the runs-store on start() with type=agent and metadata', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const { runId } = await runner.start(buildSpec({ tool: 'git_log' }));
    const run = useRunsStore.getState().entities[runId];
    expect(run).toBeDefined();
    expect(run?.type).toBe('agent');
    expect(run?.command).toBeNull();
    expect(run?.status).toBe('running');
    expect(run?.metadata.tool).toBe('git_log');
    expect(run?.metadata.source).toBe('ai');
    expect(run?.metadata.confidence).toBe(0.9);
  });

  it('emits tool-call then stream-start synchronously on start()', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const actions: AgentAction[] = [];
    runner.onStream((a) => actions.push(a));
    await runner.start(buildSpec({ tool: 'shell_exec', args: { cmd: 'ls' } }));
    // No scheduler ticks yet — only the immediate tool-call + stream-start.
    expect(actions[0]).toEqual({ kind: 'tool-call', tool: 'shell_exec', args: { cmd: 'ls' } });
    expect(actions[1]?.kind).toBe('stream-start');
  });

  it('assigns a unique runId per start() call', async () => {
    const runner = createMockAgentRunner({ scheduler: createManualScheduler() });
    const a = await runner.start(buildSpec());
    const b = await runner.start(buildSpec());
    expect(a.runId).not.toBe(b.runId);
  });
});

describe('createMockAgentRunner — stream chunks', () => {
  it('emits exactly 5 stream-chunk actions then stream-end (contract pin)', async () => {
    // Hard-code the expected count so the constant + the runner are
    // BOTH pinned. A self-referential `=== MOCK_RUN_CHUNK_COUNT` check
    // only caught internal inconsistency; this asserts the contract.
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const actions: AgentAction[] = [];
    runner.onStream((a) => actions.push(a));
    await runner.start(buildSpec());
    sched.flushAll();
    const chunks = actions.filter((a) => a.kind === 'stream-chunk');
    expect(chunks.length).toBe(5);
    // The constant should agree (sanity — fail fast if either drifts).
    expect(chunks.length).toBe(MOCK_RUN_CHUNK_COUNT);
    const ends = actions.filter((a) => a.kind === 'stream-end');
    expect(ends.length).toBe(1);
    expect(ends[0]).toMatchObject({ kind: 'stream-end', exitCode: 0 });
  });

  it('chunk bytes match the documented contract (literal payload, not helper re-call)', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const { runId } = await runner.start(buildSpec({ tool: 'git_log', args: { n: 5 } }));
    sched.flushAll();
    const run = useRunsStore.getState().entities[runId]!;
    expect(run.outputChunks.length).toBe(5);
    const decoder = new TextDecoder();
    const decoded = run.outputChunks.map((c) => decoder.decode(c));

    // Literal contract assertions — these will fail if the mock's output
    // shape changes (even if `mockChunksForSpec` is changed in lockstep
    // with its callers). Pins the byte-level shape a UI test could see.
    expect(decoded[0]).toBe('Running tool: git_log\n');
    expect(decoded[1]).toBe('Args: {"n":5}\n');
    expect(decoded[2]).toBe('step 1/3\n');
    expect(decoded[3]).toBe('step 2/3\n');
    expect(decoded[4]).toBe('step 3/3\n');

    // End-of-stream newline preserved across the join.
    const joined = decoded.join('');
    expect(joined.endsWith('step 3/3\n')).toBe(true);
    // Every chunk decoded to a non-empty string (no stray zero-byte frames).
    for (const s of decoded) expect(s.length).toBeGreaterThan(0);
  });

  it('mockChunksForSpec helper is consistent with the runner output', async () => {
    // Separate sanity check on the helper itself. Keeps the helper
    // locked to the same contract without making the contract test
    // dependent on it (defeating the round-trip).
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const spec = buildSpec({ tool: 'git_log', args: { n: 5 } });
    const { runId } = await runner.start(spec);
    sched.flushAll();
    const decoder = new TextDecoder();
    const decoded = useRunsStore
      .getState()
      .entities[runId]!.outputChunks.map((c) => decoder.decode(c));
    expect(decoded).toEqual(mockChunksForSpec(spec));
  });

  it('steps chunk-by-chunk when the caller drains one tick at a time', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const actions: AgentAction[] = [];
    runner.onStream((a) => actions.push(a));
    await runner.start(buildSpec());
    // One tick produces one chunk.
    sched.flushOne();
    expect(actions.filter((a) => a.kind === 'stream-chunk').length).toBe(1);
    sched.flushOne();
    expect(actions.filter((a) => a.kind === 'stream-chunk').length).toBe(2);
  });

  it('completes the run in the store after the final chunk', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const { runId } = await runner.start(buildSpec());
    sched.flushAll();
    const run = useRunsStore.getState().entities[runId]!;
    expect(run.status).toBe('completed');
    expect(run.exitCode).toBe(0);
    expect(run.completedAt).not.toBeNull();
  });
});

describe('createMockAgentRunner — cancellation', () => {
  it('cancel() before any tick drains flips the run to canceled', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const { runId, cancel } = await runner.start(buildSpec());
    cancel();
    const run = useRunsStore.getState().entities[runId]!;
    expect(run.status).toBe('canceled');
  });

  it('cancel() mid-stream stops further chunk emission', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const actions: AgentAction[] = [];
    runner.onStream((a) => actions.push(a));
    const { cancel } = await runner.start(buildSpec());
    // Drain one chunk then cancel; remaining ticks must be no-ops.
    sched.flushOne();
    cancel();
    sched.flushAll();
    const chunks = actions.filter((a) => a.kind === 'stream-chunk');
    expect(chunks.length).toBe(1);
  });

  it('cancel() emits a stream-end with non-zero exitCode', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const actions: AgentAction[] = [];
    runner.onStream((a) => actions.push(a));
    const { cancel } = await runner.start(buildSpec());
    cancel();
    const end = actions.find((a) => a.kind === 'stream-end');
    expect(end).toBeDefined();
    expect(end).toMatchObject({ kind: 'stream-end' });
    // Narrow manually — the discriminated union doesn't expose exitCode on
    // other variants. 130 is the SIGINT-convention exit code the mock uses.
    if (end && end.kind === 'stream-end') {
      expect(end.exitCode).toBe(130);
    }
  });

  it('repeated cancel() is idempotent — no duplicate stream-end events', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const actions: AgentAction[] = [];
    runner.onStream((a) => actions.push(a));
    const { cancel } = await runner.start(buildSpec());
    cancel();
    cancel();
    cancel();
    const ends = actions.filter((a) => a.kind === 'stream-end');
    expect(ends.length).toBe(1);
  });
});

describe('onStream subscription mechanics', () => {
  it('returns an unsubscribe function that detaches the listener', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const hits: AgentAction[] = [];
    const off = runner.onStream((a) => hits.push(a));
    off();
    await runner.start(buildSpec());
    sched.flushAll();
    expect(hits.length).toBe(0);
  });

  it('a throwing listener does not break the stream for other listeners', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const good: AgentAction[] = [];
    runner.onStream(() => {
      throw new Error('boom');
    });
    runner.onStream((a) => good.push(a));
    await runner.start(buildSpec());
    sched.flushAll();
    expect(good.length).toBeGreaterThan(0);
  });

  it('supports multiple concurrent subscribers that each see every action', async () => {
    const sched = createManualScheduler();
    const runner = createMockAgentRunner({ scheduler: sched });
    const a: AgentAction[] = [];
    const b: AgentAction[] = [];
    runner.onStream((x) => a.push(x));
    runner.onStream((x) => b.push(x));
    await runner.start(buildSpec());
    sched.flushAll();
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('mockChunksForSpec determinism', () => {
  it('produces a stable chunk list for a given spec', () => {
    const a = mockChunksForSpec(buildSpec({ tool: 'git_log', args: { n: 5 } }));
    const b = mockChunksForSpec(buildSpec({ tool: 'git_log', args: { n: 5 } }));
    expect(a).toEqual(b);
  });

  it('mentions the tool name in the first chunk', () => {
    const chunks = mockChunksForSpec(buildSpec({ tool: 'find_file' }));
    expect(chunks[0]).toContain('find_file');
  });

  it('embeds a stringified args preview in the second chunk', () => {
    const chunks = mockChunksForSpec(buildSpec({ tool: 'x', args: { a: 1 } }));
    expect(chunks[1]).toContain('"a":1');
  });

  it('produces exactly MOCK_RUN_CHUNK_COUNT entries', () => {
    const chunks = mockChunksForSpec(buildSpec());
    expect(chunks.length).toBe(MOCK_RUN_CHUNK_COUNT);
  });
});

describe('bindAgentRunner / getAgentRunner registry', () => {
  it('returns a mock runner by default', () => {
    const runner = getAgentRunner();
    expect(typeof runner.start).toBe('function');
  });

  it('bindAgentRunner overrides the installed runner', () => {
    const custom: ReturnType<typeof createMockAgentRunner> = {
      start: vi.fn(async () => ({ runId: 'stub', cancel: () => undefined })),
      onStream: vi.fn(() => () => undefined),
    };
    bindAgentRunner(custom);
    expect(getAgentRunner()).toBe(custom);
  });

  it('resetAgentRunnerForTests restores a fresh mock', async () => {
    const custom: ReturnType<typeof createMockAgentRunner> = {
      start: vi.fn(async () => ({ runId: 'stub', cancel: () => undefined })),
      onStream: vi.fn(() => () => undefined),
    };
    bindAgentRunner(custom);
    resetAgentRunnerForTests();
    expect(getAgentRunner()).not.toBe(custom);
  });
});
