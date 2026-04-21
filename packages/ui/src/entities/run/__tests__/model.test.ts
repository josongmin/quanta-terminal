/**
 * Run entity — shape validation and type narrowing tests.
 *
 * Focused on the pure types / helpers in model.ts. Store lifecycle lives in
 * runs-store.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_CONFIDENCE,
  DEFAULT_RUN_OUTPUT_TYPE,
  TERMINAL_RUN_STATES,
  isTerminalRunState,
  type OutputType,
  type Run,
  type RunId,
  type RunState,
  type RunType,
} from '../model.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const SESSION = 'sess-1' as SessionId;

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r-1' as RunId,
    type: 'shell',
    parentRunId: null,
    sessionId: SESSION,
    state: 'pending',
    command: 'ls',
    cwd: '/tmp',
    startedAt: 1000,
    completedAt: null,
    exitCode: null,
    signal: null,
    confidence: 1,
    resourceUsage: null,
    outputType: 'text',
    semanticRange: null,
    metadata: {},
    ...overrides,
  };
}

describe('Run model — constants', () => {
  it('DEFAULT_RUN_CONFIDENCE is 1 (authoritative)', () => {
    expect(DEFAULT_RUN_CONFIDENCE).toBe(1);
  });

  it('DEFAULT_RUN_OUTPUT_TYPE is text', () => {
    expect(DEFAULT_RUN_OUTPUT_TYPE).toBe('text' satisfies OutputType);
  });

  it('TERMINAL_RUN_STATES contains completed/failed/canceled/killed — and nothing else', () => {
    expect(TERMINAL_RUN_STATES.has('completed')).toBe(true);
    expect(TERMINAL_RUN_STATES.has('failed')).toBe(true);
    expect(TERMINAL_RUN_STATES.has('canceled')).toBe(true);
    expect(TERMINAL_RUN_STATES.has('killed')).toBe(true);
    expect(TERMINAL_RUN_STATES.has('pending')).toBe(false);
    expect(TERMINAL_RUN_STATES.has('running')).toBe(false);
    expect(TERMINAL_RUN_STATES.has('suspended')).toBe(false);
    expect(TERMINAL_RUN_STATES.size).toBe(4);
  });
});

describe('Run model — isTerminalRunState', () => {
  it('classifies non-terminal states as non-terminal', () => {
    const nonTerminal: RunState[] = ['pending', 'running', 'suspended'];
    for (const s of nonTerminal) expect(isTerminalRunState(s)).toBe(false);
  });

  it('classifies terminal states as terminal', () => {
    const terminal: RunState[] = ['completed', 'failed', 'canceled', 'killed'];
    for (const s of terminal) expect(isTerminalRunState(s)).toBe(true);
  });
});

describe('Run model — type narrowing', () => {
  it('constructs a plausible Run with all required fields', () => {
    const r = makeRun();
    expect(r.id).toBe('r-1');
    expect(r.type).toBe('shell' satisfies RunType);
    expect(r.parentRunId).toBeNull();
    expect(r.metadata).toEqual({});
  });

  it('allows parentRunId to be a RunId brand', () => {
    const r = makeRun({ parentRunId: 'parent-1' as RunId });
    expect(r.parentRunId).toBe('parent-1');
  });

  it('accepts any RunType value', () => {
    const types: RunType[] = ['shell', 'task', 'agent', 'replay', 'subrun'];
    for (const t of types) {
      expect(makeRun({ type: t }).type).toBe(t);
    }
  });

  it('allows semanticRange to populate authoritative row fields', () => {
    const r = makeRun({
      semanticRange: {
        promptStartRow: 10,
        commandStartRow: 11,
        outputStartRow: 12,
        outputEndRow: 20,
      },
    });
    expect(r.semanticRange?.outputEndRow).toBe(20);
  });

  it('metadata is type-level readonly but structurally a plain record', () => {
    const r = makeRun({ metadata: { agentModel: 'claude-3', tokens: 12 } });
    expect(r.metadata.agentModel).toBe('claude-3');
    expect(r.metadata.tokens).toBe(12);
  });
});
