/**
 * useExplainBlock — state machine & output-projection tests.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useBlockStore } from '../../../entities/block/index.js';
import {
  EXPLAIN_NOT_CONFIGURED_MESSAGE,
  type ExplainErrorRequest,
  type SuggestionPort,
} from '../../ai-suggest/index.js';
import {
  MAX_OUTPUT_BYTES,
  projectOutputForExplain,
  useExplainBlock,
} from '../useExplainBlock.js';

function stubPort(partial: Partial<SuggestionPort> = {}): SuggestionPort {
  return {
    suggest: async () => {
      throw new Error('not used');
    },
    explainError: async () => 'stub',
    suggestCorrection: () => [],
    ...partial,
  };
}

function seedFailedBlock(command: string, output: string, exitCode = 1): string {
  const id = useBlockStore.getState().createBlock(command, '/tmp');
  useBlockStore
    .getState()
    .appendBlockOutput(id, new TextEncoder().encode(output));
  useBlockStore.getState().completeBlock(id, exitCode);
  return id;
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('projectOutputForExplain', () => {
  it('returns empty string for no chunks', () => {
    expect(projectOutputForExplain([])).toBe('');
  });

  it('decodes a small set of chunks in order', () => {
    const chunks = [
      new TextEncoder().encode('hello '),
      new TextEncoder().encode('world'),
    ];
    expect(projectOutputForExplain(chunks)).toBe('hello world');
  });

  it('strips ANSI escape sequences', () => {
    const chunks = [new TextEncoder().encode('\x1b[31mred text\x1b[0m')];
    expect(projectOutputForExplain(chunks)).toBe('red text');
  });

  it('only keeps the last MAX_OUTPUT_BYTES bytes of output', () => {
    // 10KB of output, only last 4KB (MAX_OUTPUT_BYTES) should survive.
    const filler = 'A'.repeat(8 * 1024);
    const tailMarker = 'ZZZ_END';
    const chunks = [
      new TextEncoder().encode(filler),
      new TextEncoder().encode(tailMarker),
    ];
    const projected = projectOutputForExplain(chunks);
    expect(projected.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(projected.endsWith(tailMarker)).toBe(true);
    expect(projected.startsWith('A')).toBe(true);
  });
});

describe('useExplainBlock state machine', () => {
  it('starts in idle with explanation=null', () => {
    const id = seedFailedBlock('ls', 'oops', 1);
    const { result } = renderHook(() =>
      useExplainBlock(id, { port: stubPort() }),
    );
    expect(result.current.state).toBe('idle');
    expect(result.current.explanation).toBeNull();
  });

  it('transitions idle -> loading -> done on a successful explain', async () => {
    const id = seedFailedBlock('ls', 'Error: missing', 1);
    const port = stubPort({
      explainError: async () =>
        '`ls` exited **1** because the path was missing.',
    });
    const { result } = renderHook(() => useExplainBlock(id, { port }));
    act(() => result.current.explain());
    // Synchronously we should be loading.
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.explanation).toContain('`ls`');
  });

  it('maps the not-configured sentinel to the not-configured state', async () => {
    const id = seedFailedBlock('ls', 'boom', 1);
    const port = stubPort({
      explainError: async () => EXPLAIN_NOT_CONFIGURED_MESSAGE,
    });
    const { result } = renderHook(() => useExplainBlock(id, { port }));
    act(() => result.current.explain());
    await waitFor(() =>
      expect(result.current.state).toBe('not-configured'),
    );
    expect(result.current.explanation).toBeNull();
  });

  it('maps a thrown error to the error state', async () => {
    const id = seedFailedBlock('ls', 'boom', 1);
    const port = stubPort({
      explainError: async () => {
        throw new Error('network');
      },
    });
    const { result } = renderHook(() => useExplainBlock(id, { port }));
    act(() => result.current.explain());
    await waitFor(() => expect(result.current.state).toBe('error'));
  });

  it('explain() while loading is a no-op (idempotent double-click)', async () => {
    const id = seedFailedBlock('ls', 'boom', 1);
    let resolvedCount = 0;
    const port = stubPort({
      explainError: async () => {
        resolvedCount += 1;
        return 'ok';
      },
    });
    const { result } = renderHook(() => useExplainBlock(id, { port }));
    act(() => {
      result.current.explain();
      result.current.explain();
      result.current.explain();
    });
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(resolvedCount).toBe(1);
  });

  it('explain() while done is a no-op unless reset() fires', async () => {
    const id = seedFailedBlock('ls', 'boom', 1);
    const spy = vi.fn(async () => 'first');
    const port = stubPort({ explainError: spy });
    const { result } = renderHook(() => useExplainBlock(id, { port }));
    act(() => result.current.explain());
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => result.current.explain());
    expect(spy).toHaveBeenCalledTimes(1);
    // Now reset and re-explain.
    act(() => result.current.reset());
    expect(result.current.state).toBe('idle');
    act(() => result.current.explain());
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('explain() from error re-enters loading and retries', async () => {
    const id = seedFailedBlock('ls', 'boom', 1);
    let calls = 0;
    const port = stubPort({
      explainError: async () => {
        calls += 1;
        if (calls === 1) throw new Error('first');
        return 'second-ok';
      },
    });
    const { result } = renderHook(() => useExplainBlock(id, { port }));
    act(() => result.current.explain());
    await waitFor(() => expect(result.current.state).toBe('error'));
    act(() => result.current.explain());
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.explanation).toBe('second-ok');
  });

  it('forwards command, output, and exitCode to the port', async () => {
    const id = seedFailedBlock('make build', 'fatal error\n', 2);
    const explainFn = vi.fn(async (_req: ExplainErrorRequest) => 'explanation');
    const port = stubPort({ explainError: explainFn });
    const { result } = renderHook(() => useExplainBlock(id, { port }));
    act(() => result.current.explain());
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(explainFn).toHaveBeenCalledOnce();
    const req = explainFn.mock.calls[0]![0];
    expect(req.command).toBe('make build');
    expect(req.exitCode).toBe(2);
    expect(req.output).toContain('fatal error');
  });

  it('options.port dep: uses the updated port when it changes between renders (Bug 4)', async () => {
    const id = seedFailedBlock('ls', 'boom', 1);
    const portA = stubPort({ explainError: async () => 'from-port-A' });
    const portB = stubPort({ explainError: async () => 'from-port-B' });
    const { result, rerender } = renderHook(
      ({ port }: { port: SuggestionPort }) => useExplainBlock(id, { port }),
      { initialProps: { port: portA } },
    );
    act(() => result.current.explain());
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.explanation).toBe('from-port-A');

    // Reset and switch to portB.
    act(() => result.current.reset());
    rerender({ port: portB });
    act(() => result.current.explain());
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.explanation).toBe('from-port-B');
  });

  it('reset() discards a pending in-flight result', async () => {
    const id = seedFailedBlock('ls', 'boom', 1);
    let resolveIt: ((v: string) => void) | null = null;
    const pending = new Promise<string>((resolve) => {
      resolveIt = resolve;
    });
    const port = stubPort({
      explainError: () => pending,
    });
    const { result } = renderHook(() => useExplainBlock(id, { port }));
    act(() => result.current.explain());
    expect(result.current.state).toBe('loading');
    act(() => result.current.reset());
    expect(result.current.state).toBe('idle');
    // Even if the promise settles now, state must not flip back to 'done'.
    act(() => resolveIt!('ignored'));
    await Promise.resolve();
    expect(result.current.state).toBe('idle');
  });
});
