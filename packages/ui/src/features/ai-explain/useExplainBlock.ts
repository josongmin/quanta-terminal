/**
 * `useExplainBlock` — hook owning the request lifecycle for "AI, explain
 * this error."
 *
 * Responsibilities
 * ----------------
 *   - Collect the block's `command`, exit code, and a decoded, ANSI-stripped
 *     slice of output (last ~4kB — see `MAX_OUTPUT_BYTES` below).
 *   - Call `SuggestionPort.explainError({ command, output, exitCode })`.
 *   - Map the returned promise onto a small state machine the panel renders.
 *
 * State machine
 * -------------
 *         reset()                 reset()
 *     idle ────► idle          done ────► idle
 *       │                         ▲
 *       │ explain()               │
 *       ▼                         │
 *     loading ───success (non-sentinel)──► done
 *           │
 *           ├── success (EXPLAIN_NOT_CONFIGURED_MESSAGE) ──► not-configured
 *           │
 *           └── throw ──► error
 *
 * Re-entrancy rules:
 *   - `explain()` while `loading` is a no-op (idempotent double-click guard).
 *   - `explain()` while `done` / `not-configured` is a no-op (the panel is
 *     static once resolved; use `reset()` to re-request, e.g. the retry path
 *     from `error`).
 *   - `explain()` from `error` re-enters `loading` and re-requests.
 *
 * Stale-promise guard: if the component unmounts (or `reset()` fires) while
 * a request is in flight, the resolved value is ignored. We track this with
 * a numeric run id captured when the request fires; a completion that does
 * not match the current run id is dropped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { stripAnsi } from '../../shared/lib/ansi-parser/index.js';
import {
  useBlock,
  type Block,
} from '../../entities/block/index.js';
import {
  EXPLAIN_NOT_CONFIGURED_MESSAGE,
  getSuggestionPort,
  type SuggestionPort,
} from '../ai-suggest/index.js';

export type ExplainState =
  | 'idle'
  | 'loading'
  | 'done'
  | 'error'
  | 'not-configured';

/**
 * Upper bound on the output bytes forwarded to the provider. Keeps the
 * prompt size bounded (real providers charge per-token) and matches the
 * comment in `provider-port.ts::ExplainErrorRequest`. The hook takes the
 * TAIL of the output — error messages almost always land near the end of
 * a failed process's stream, and truncating the head is better than
 * dropping the final "Error: …" line.
 */
export const MAX_OUTPUT_BYTES = 4 * 1024;

export interface UseExplainBlockOptions {
  /** Port override (tests). Defaults to the globally-installed port. */
  readonly port?: SuggestionPort;
}

export interface UseExplainBlockResult {
  readonly state: ExplainState;
  /**
   * Non-null only when `state === 'done'`. The raw markdown paragraph
   * returned by the provider. Not sanitized at the hook layer — the panel
   * renders it through `renderSimpleMarkdown`.
   */
  readonly explanation: string | null;
  /**
   * Fire an `explainError` request. No-op when a request is already in
   * flight or we already have a settled non-error result. Transitions from
   * `error` back into `loading` (user clicked Retry).
   */
  readonly explain: () => void;
  /** Return to `idle` and discard any in-flight result. */
  readonly reset: () => void;
}

/**
 * Project the block's `outputChunks` into a single utf-8 decoded string,
 * stripped of ANSI escapes, bounded to the last MAX_OUTPUT_BYTES bytes.
 *
 * Why strip before slicing? We slice the RAW bytes first (tail only so the
 * decode step stays cheap on multi-megabyte outputs), decode with a permissive
 * TextDecoder that emits U+FFFD for broken codepoints, then pass through
 * `stripAnsi` to remove SGR noise. The returned text is plain, provider-ready.
 *
 * Exported so tests can exercise the byte-budget independently of the hook.
 */
export function projectOutputForExplain(chunks: readonly Uint8Array[]): string {
  if (chunks.length === 0) return '';
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  // Walk back from the tail collecting at most MAX_OUTPUT_BYTES bytes.
  let budget = Math.min(total, MAX_OUTPUT_BYTES);
  const tail = new Uint8Array(budget);
  let offset = tail.byteLength;
  for (let i = chunks.length - 1; i >= 0 && budget > 0; i -= 1) {
    const c = chunks[i]!;
    if (c.byteLength <= budget) {
      offset -= c.byteLength;
      tail.set(c, offset);
      budget -= c.byteLength;
    } else {
      // Take only the trailing `budget` bytes of this chunk.
      const slice = c.subarray(c.byteLength - budget);
      offset -= slice.byteLength;
      tail.set(slice, offset);
      budget = 0;
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return stripAnsi(decoder.decode(tail));
}

interface ExplainInputs {
  readonly command: string;
  readonly output: string;
  readonly exitCode: number;
}

function buildInputs(block: Block | undefined): ExplainInputs | null {
  if (!block) return null;
  if (block.exitCode === null) return null;
  return {
    command: block.command,
    output: projectOutputForExplain(block.outputChunks),
    exitCode: block.exitCode,
  };
}

export function useExplainBlock(
  blockId: string,
  options: UseExplainBlockOptions = {},
): UseExplainBlockResult {
  const block = useBlock(blockId);
  const [state, setState] = useState<ExplainState>('idle');
  const [explanation, setExplanation] = useState<string | null>(null);

  // Monotonic run id — every `explain()` call bumps this. Async completions
  // compare against the latched id and drop stale results. A re-mount starts
  // fresh at 0 which is still safe because the hook clears state anyway.
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);
  // Synchronous shadow of `state`. Necessary because React batches the
  // `setState('loading')` inside `explain()`; a double-click within the
  // same tick would otherwise see the stale `state` closure and fire a
  // second request. The ref lets the guard trip immediately.
  const stateRef = useRef<ExplainState>('idle');
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const explain = useCallback(() => {
    // Idempotent guards — no re-request from terminal / in-flight states.
    const current = stateRef.current;
    if (current === 'loading') return;
    if (current === 'done' || current === 'not-configured') return;
    const inputs = buildInputs(block);
    if (!inputs) return;
    const port = options.port ?? getSuggestionPort();
    const myRunId = runIdRef.current + 1;
    runIdRef.current = myRunId;
    stateRef.current = 'loading';
    setState('loading');
    setExplanation(null);
    void Promise.resolve()
      .then(() => port.explainError(inputs))
      .then((result) => {
        if (!mountedRef.current) return;
        if (runIdRef.current !== myRunId) return;
        if (result === EXPLAIN_NOT_CONFIGURED_MESSAGE) {
          stateRef.current = 'not-configured';
          setState('not-configured');
          setExplanation(null);
          return;
        }
        stateRef.current = 'done';
        setState('done');
        setExplanation(result);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        if (runIdRef.current !== myRunId) return;
        stateRef.current = 'error';
        setState('error');
        setExplanation(null);
      });
  }, [block, options.port]);

  const reset = useCallback(() => {
    // Bumping the run id invalidates any in-flight resolution.
    runIdRef.current += 1;
    stateRef.current = 'idle';
    setState('idle');
    setExplanation(null);
  }, []);

  return { state, explanation, explain, reset };
}
