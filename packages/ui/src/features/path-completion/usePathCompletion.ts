import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompletionEntry } from '@quanta/host-common';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { extractPathToken, type PathToken } from './parse-token.js';

export interface UsePathCompletionArgs {
  readonly value: string;
  readonly caret: number;
  readonly cwd: string;
  readonly disabled?: boolean;
}

export interface UsePathCompletionResult {
  readonly items: readonly CompletionEntry[];
  readonly activeIndex: number;
  readonly token: PathToken | null;
  readonly setActiveIndex: (i: number) => void;
  readonly dismiss: () => void;
  readonly accept: (item: CompletionEntry) => string;
}

const DEBOUNCE_MS = 80;

export function usePathCompletion({
  value,
  caret,
  cwd,
  disabled = false,
}: UsePathCompletionArgs): UsePathCompletionResult {
  const [items, setItems] = useState<CompletionEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [token, setToken] = useState<PathToken | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (disabled) {
      setItems([]);
      setToken(null);
      return;
    }

    const tok = extractPathToken(value, caret);

    if (!tok) {
      setItems([]);
      setToken(null);
      lastTokenRef.current = null;
      return;
    }

    // If the token text changed, clear dismissal so new completions can show.
    if (tok.text !== lastTokenRef.current) {
      setDismissed(false);
      lastTokenRef.current = tok.text;
    }

    if (dismissed) {
      setToken(tok);
      return;
    }

    setToken(tok);

    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const bridge = tryGetHostBridge();
      if (!bridge?.listCompletions) {
        setItems([]);
        return;
      }
      bridge.listCompletions({ prefix: tok.text, cwd }).then((entries) => {
        setItems(entries);
        setActiveIndex(0);
      }).catch(() => {
        setItems([]);
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, caret, cwd, disabled, dismissed]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    setItems([]);
  }, []);

  // Returns the new composer value after inserting the completion.
  const accept = useCallback((item: CompletionEntry): string => {
    if (!token) return value;
    return value.slice(0, token.start) + item.insert + value.slice(token.end);
  }, [token, value]);

  const visible = !dismissed && items.length > 0;

  return {
    items: visible ? items : [],
    activeIndex,
    token,
    setActiveIndex,
    dismiss,
    accept,
  };
}
