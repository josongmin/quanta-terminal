/**
 * `useSuggest` — hook that debounces user input and asks the installed
 * provider port for a suggestion.
 *
 * Shape:
 *   - `setPrompt(text)` — call on every keystroke.
 *   - `suggestion` — the last received suggestion, or null.
 *   - `loading` — true while a request is in flight.
 *   - `error` — the most recent error (cleared on the next successful call).
 *
 * Debounce
 * --------
 * The hook fires at most once per `DEBOUNCE_MS` per unique trailing prompt
 * value. Cancellation on unmount uses a `ref`-tracked request id so a
 * late-returning provider never stomps on newer state.
 *
 * The suggestion is also pushed into the `entities/ai` store so other chrome
 * (suggestion-bar, command palette "Ask AI" mode) can read it without
 * needing the hook. The store + hook dual-update is what features/composer
 * already does for its own submit pipeline.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAiStore, type AiSuggestion } from '../../entities/ai/index.js';
import { getSuggestionPort, type SuggestionPort } from './provider-port.js';

/** Default debounce. 250ms strikes a balance between "feels responsive" and
 *  "doesn't DOS the provider every keystroke"; the command-palette input
 *  settles for one frame before we trigger a fetch. */
export const DEFAULT_SUGGEST_DEBOUNCE_MS = 250;

export interface UseSuggestOptions {
  /** Override the installed port. Tests pass their own mock. */
  readonly port?: SuggestionPort;
  /** Debounce window. Tests pass `0` to go synchronous. */
  readonly debounceMs?: number;
  /** Working-directory hint forwarded to the provider. */
  readonly cwd?: string;
}

export interface UseSuggestResult {
  readonly suggestion: AiSuggestion | null;
  readonly loading: boolean;
  readonly error: Error | null;
  setPrompt(text: string): void;
  clear(): void;
}

interface RequestToken {
  id: number;
  cancelled: boolean;
}

export function useSuggest(options: UseSuggestOptions = {}): UseSuggestResult {
  const { port = getSuggestionPort(), debounceMs = DEFAULT_SUGGEST_DEBOUNCE_MS, cwd } = options;

  const [suggestion, setSuggestion] = useState<AiSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Refs track the "live" request so a late-returning provider whose id no
  // longer matches is dropped silently — the hook only commits the latest.
  const currentTokenRef = useRef<RequestToken | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextIdRef = useRef(0);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (currentTokenRef.current) currentTokenRef.current.cancelled = true;
    },
    [],
  );

  const setPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (!trimmed) {
        setSuggestion(null);
        setLoading(false);
        setError(null);
        useAiStore.getState().setSuggestion(null);
        return;
      }
      const fire = async () => {
        nextIdRef.current += 1;
        const token: RequestToken = { id: nextIdRef.current, cancelled: false };
        currentTokenRef.current = token;
        setLoading(true);
        try {
          const result = await port.suggest({ prompt: trimmed, ...(cwd !== undefined ? { cwd } : {}) });
          if (token.cancelled || currentTokenRef.current?.id !== token.id) return;
          setSuggestion(result);
          setError(null);
          useAiStore.getState().setSuggestion(result);
        } catch (err) {
          if (token.cancelled || currentTokenRef.current?.id !== token.id) return;
          const e = err instanceof Error ? err : new Error(String(err));
          setError(e);
          setSuggestion(null);
          useAiStore.getState().setSuggestion(null);
        } finally {
          if (!token.cancelled && currentTokenRef.current?.id === token.id) {
            setLoading(false);
          }
        }
      };
      if (debounceMs <= 0) {
        void fire();
      } else {
        timerRef.current = setTimeout(() => {
          void fire();
        }, debounceMs);
      }
    },
    [port, debounceMs, cwd],
  );

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (currentTokenRef.current) currentTokenRef.current.cancelled = true;
    setSuggestion(null);
    setLoading(false);
    setError(null);
    useAiStore.getState().setSuggestion(null);
  }, []);

  return { suggestion, loading, error, setPrompt, clear };
}
