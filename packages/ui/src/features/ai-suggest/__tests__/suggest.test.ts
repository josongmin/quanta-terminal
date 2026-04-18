/**
 * Tests for `useSuggest` — the debounced suggestion hook.
 *
 * We run the hook with the testing-library `renderHook` helper so the debounce
 * timer behaviour can be asserted with `act` + `vi.useFakeTimers`.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiStore } from '../../../entities/ai/index.js';
import { useSuggest } from '../suggest.js';
import type { AiSuggestion } from '../../../entities/ai/index.js';
import type { SuggestionPort } from '../provider-port.js';

function makePort(overrides: Partial<SuggestionPort> = {}): SuggestionPort {
  return {
    suggest: overrides.suggest ?? (async (req) => sample(req.prompt)),
  };
}

function sample(prompt: string): AiSuggestion {
  return {
    id: `s-${prompt}`,
    classified: {
      command: `echo ${prompt}`,
      tier: 'safe',
      modifiers: [],
      rulesetVersion: 1,
    },
    rationale: 'mock',
    receivedAt: 1,
  };
}

describe('features/ai-suggest useSuggest', () => {
  beforeEach(() => {
    useAiStore.getState().resetAll();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('starts with no suggestion, no loading, no error', () => {
    const { result } = renderHook(() => useSuggest({ port: makePort(), debounceMs: 0 }));
    expect(result.current.suggestion).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('synchronous debounceMs=0 fires immediately', async () => {
    const port = makePort();
    const { result } = renderHook(() => useSuggest({ port, debounceMs: 0 }));
    await act(async () => {
      result.current.setPrompt('hello');
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => {
      expect(result.current.suggestion?.id).toBe('s-hello');
    });
  });

  it('debounces multiple keystrokes into one call', async () => {
    const suggest = vi.fn().mockImplementation(async (req: { prompt: string }) => sample(req.prompt));
    const port: SuggestionPort = { suggest };
    const { result } = renderHook(() => useSuggest({ port, debounceMs: 100 }));
    act(() => {
      result.current.setPrompt('a');
      result.current.setPrompt('ab');
      result.current.setPrompt('abc');
    });
    expect(suggest).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    await waitFor(() => {
      expect(suggest).toHaveBeenCalledTimes(1);
    });
    expect(suggest.mock.calls.at(0)?.[0]).toEqual({ prompt: 'abc' });
  });

  it('empty prompt clears the suggestion without calling the port', async () => {
    const suggest = vi.fn();
    const port: SuggestionPort = { suggest };
    const { result } = renderHook(() => useSuggest({ port, debounceMs: 0 }));
    act(() => {
      result.current.setPrompt('   ');
    });
    expect(suggest).not.toHaveBeenCalled();
    expect(result.current.suggestion).toBeNull();
  });

  it('writes the suggestion into the ai store', async () => {
    const { result } = renderHook(() => useSuggest({ port: makePort(), debounceMs: 0 }));
    await act(async () => {
      result.current.setPrompt('foo');
      await vi.advanceTimersByTimeAsync(1);
    });
    await waitFor(() => {
      expect(useAiStore.getState().currentSuggestion?.id).toBe('s-foo');
    });
  });

  it('surfaces provider errors on the hook state', async () => {
    const boom = new Error('nope');
    const port: SuggestionPort = { suggest: async () => { throw boom; } };
    const { result } = renderHook(() => useSuggest({ port, debounceMs: 0 }));
    await act(async () => {
      result.current.setPrompt('err');
      await vi.advanceTimersByTimeAsync(1);
    });
    await waitFor(() => {
      expect(result.current.error?.message).toBe('nope');
    });
    expect(result.current.suggestion).toBeNull();
  });

  it('clear() cancels in-flight requests', async () => {
    let resolveIt: ((v: AiSuggestion) => void) | null = null;
    const port: SuggestionPort = {
      suggest: async () =>
        new Promise<AiSuggestion>((resolve) => {
          resolveIt = resolve;
        }),
    };
    const { result } = renderHook(() => useSuggest({ port, debounceMs: 0 }));
    act(() => {
      result.current.setPrompt('slow');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    act(() => {
      result.current.clear();
    });
    // Late resolution must not be committed to state.
    await act(async () => {
      if (resolveIt) (resolveIt as (v: AiSuggestion) => void)(sample('slow'));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.suggestion).toBeNull();
  });

  it('only commits the latest request when two are in flight', async () => {
    const pending: Array<(v: AiSuggestion) => void> = [];
    const port: SuggestionPort = {
      suggest: async () =>
        new Promise<AiSuggestion>((resolve) => {
          pending.push(resolve);
        }),
    };
    const { result } = renderHook(() => useSuggest({ port, debounceMs: 0 }));
    act(() => {
      result.current.setPrompt('one');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    act(() => {
      result.current.setPrompt('two');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // Resolve the OLDER request first — it must be dropped.
    await act(async () => {
      pending.at(0)!(sample('one'));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.suggestion?.id).not.toBe('s-one');
    // Now the newer.
    await act(async () => {
      pending.at(1)!(sample('two'));
      await vi.advanceTimersByTimeAsync(1);
    });
    await waitFor(() => {
      expect(result.current.suggestion?.id).toBe('s-two');
    });
  });

  it('forwards cwd to the provider when provided', async () => {
    const suggest = vi.fn().mockImplementation(async () => sample('ok'));
    const port: SuggestionPort = { suggest };
    const { result } = renderHook(() => useSuggest({ port, debounceMs: 0, cwd: '/tmp/work' }));
    await act(async () => {
      result.current.setPrompt('hi');
      await vi.advanceTimersByTimeAsync(1);
    });
    await waitFor(() => expect(suggest).toHaveBeenCalled());
    expect(suggest.mock.calls.at(0)?.[0]).toEqual({ prompt: 'hi', cwd: '/tmp/work' });
  });
});
