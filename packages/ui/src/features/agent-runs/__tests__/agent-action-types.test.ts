/**
 * Agent action types — discrimination + helpers.
 *
 * Scope: pure type / helper unit tests. No store, no runner, no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  assertNever,
  isStreamActionFor,
  type AgentAction,
  type AgentRunSpec,
} from '../agent-action-types.js';

/**
 * Exhaustively visit every branch of an AgentAction via a switch, so the
 * discriminant narrowing is type-checked at compile time and each branch
 * is hit at runtime. The implementation lives here (not production code)
 * because it's a test harness — real callers narrow inline in their
 * specific consumer.
 */
function describeAction(action: AgentAction): string {
  switch (action.kind) {
    case 'tool-call':
      return `tool:${action.tool}`;
    case 'message':
      return `msg:${action.text}`;
    case 'stream-start':
      return `start:${action.runId}`;
    case 'stream-chunk':
      return `chunk:${action.runId}:${action.bytes.byteLength}`;
    case 'stream-end':
      return `end:${action.runId}:${action.exitCode}`;
    default:
      return assertNever(action);
  }
}

describe('AgentAction discrimination', () => {
  it('narrows via a switch on `kind` for every variant', () => {
    expect(describeAction({ kind: 'tool-call', tool: 'git_log', args: { n: 5 } })).toBe(
      'tool:git_log',
    );
    expect(describeAction({ kind: 'message', text: 'hi' })).toBe('msg:hi');
    expect(describeAction({ kind: 'stream-start', runId: 'r' })).toBe('start:r');
    expect(
      describeAction({ kind: 'stream-chunk', runId: 'r', bytes: new Uint8Array([1, 2, 3]) }),
    ).toBe('chunk:r:3');
    expect(describeAction({ kind: 'stream-end', runId: 'r', exitCode: 0 })).toBe('end:r:0');
  });

  it('recognises a tool-call action as NOT a stream for any runId', () => {
    const action: AgentAction = { kind: 'tool-call', tool: 'a', args: {} };
    expect(isStreamActionFor(action, 'run-1')).toBe(false);
  });

  it('recognises a message action as NOT a stream', () => {
    const action: AgentAction = { kind: 'message', text: 'hello' };
    expect(isStreamActionFor(action, 'run-1')).toBe(false);
  });

  it('matches stream-start / chunk / end on runId and only for that runId', () => {
    const runId = 'run-42';
    const start: AgentAction = { kind: 'stream-start', runId };
    const chunk: AgentAction = {
      kind: 'stream-chunk',
      runId,
      bytes: new Uint8Array([1]),
    };
    const end: AgentAction = { kind: 'stream-end', runId, exitCode: 0 };
    expect(isStreamActionFor(start, runId)).toBe(true);
    expect(isStreamActionFor(chunk, runId)).toBe(true);
    expect(isStreamActionFor(end, runId)).toBe(true);
    expect(isStreamActionFor(start, 'other')).toBe(false);
  });

  it('assertNever throws with a stringified payload for defensive coverage', () => {
    // Cast via unknown so the call compiles — mimics what a future
    // untagged variant would produce at a switch's default branch.
    expect(() => assertNever({ kind: '_bogus' } as unknown as never)).toThrow(/unexpected/);
  });
});

describe('AgentRunSpec shape', () => {
  it('carries tool, args, source, confidence as a frozen-style spec', () => {
    const spec: AgentRunSpec = {
      type: 'agent',
      tool: 'shell_exec',
      args: { cmd: 'ls' },
      source: 'ai',
      confidence: 0.92,
    };
    expect(spec.type).toBe('agent');
    expect(spec.source).toBe('ai');
    expect(spec.confidence).toBeGreaterThan(0);
  });

  it('accepts the user source variant for manual / palette invocations', () => {
    const spec: AgentRunSpec = {
      type: 'agent',
      tool: 'git_log',
      args: {},
      source: 'user',
      confidence: 1.0,
    };
    expect(spec.source).toBe('user');
  });
});
