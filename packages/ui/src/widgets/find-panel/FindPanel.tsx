/**
 * FindPanel — grid-wide find surface (Plan 0005 P1-F).
 *
 * Sits at the top-right of the terminal surface (differs from the P0
 * `OutputSearch` bottom-right dock so the two can co-exist during the
 * transition). Cmd+F / Ctrl+F opens the panel, focuses the input, and
 * begins debounced indexing against whichever emulator the parent hands
 * in via `getEmulator()`.
 *
 * Navigation mirrors browser find-in-page: Enter → next, Shift+Enter →
 * prev, Esc closes and returns focus to the session input surface. A
 * live `23 of 512` counter updates as the index rebuilds.
 *
 * The widget doesn't manage the visual overlay — it just maintains a
 * store of grid-space matches + the current index. `TerminalCanvas` reads
 * `useFindPanelStore` and forwards matches to `CellBuffer.setSearchHighlights`
 * (see `cell-renderer/CellBuffer.ts`). Decoupling the two lets the panel
 * run headless in tests without pulling in the canvas stack.
 *
 * Emulator lookup: the parent decides where the emulator lives (session
 * engine, tui-render-surface, etc.) and supplies a getter. Passing a
 * callback rather than the emulator itself means the panel re-reads each
 * time the debounce timer fires, so a session switch while the panel is
 * open indexes against the freshly-active grid on the very next keystroke.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
} from 'react';

import { cx } from '../../shared/lib/cx.js';
import {
  searchGridWithQuery,
  type GridSearchEmulator,
  type GridSearchMatch,
} from '../../features/output-search/scrollback-search.js';

import { useFindPanelStore } from './find-panel-store.js';
import styles from './find-panel.module.css';

export interface FindPanelProps {
  /** Supplies the emulator to search against. Called each debounce tick. */
  readonly getEmulator: () => GridSearchEmulator | null;
  /**
   * Invoked when the active match changes so the terminal surface can scroll
   * the matched row into view. `null` means "clear scroll-to-match".
   */
  readonly onScrollToMatch?: (match: GridSearchMatch | null) => void;
  /** Debounced input delay in ms. Defaults to 150 (spec). */
  readonly debounceMs?: number;
  /** Hard cap on match-count. Forwarded to `searchGrid`. */
  readonly maxResults?: number;
  /** Test hook — override the default window-scoped timers. */
  readonly scheduler?: {
    readonly setTimeout: (cb: () => void, ms: number) => number;
    readonly clearTimeout: (id: number) => void;
  };
}

function FindPanelImpl(props: FindPanelProps) {
  const {
    getEmulator,
    onScrollToMatch,
    debounceMs = 150,
    maxResults,
    scheduler,
  } = props;

  const open = useFindPanelStore((s) => s.open);
  const query = useFindPanelStore((s) => s.query);
  const regex = useFindPanelStore((s) => s.regex);
  const caseSensitive = useFindPanelStore((s) => s.caseSensitive);
  const wholeWord = useFindPanelStore((s) => s.wholeWord);
  const matches = useFindPanelStore((s) => s.matches);
  const currentIndex = useFindPanelStore((s) => s.currentIndex);
  const error = useFindPanelStore((s) => s.error);
  const setQuery = useFindPanelStore((s) => s.setQuery);
  const setRegex = useFindPanelStore((s) => s.setRegex);
  const setCaseSensitive = useFindPanelStore((s) => s.setCaseSensitive);
  const setWholeWord = useFindPanelStore((s) => s.setWholeWord);
  const setMatches = useFindPanelStore((s) => s.setMatches);
  const close = useFindPanelStore((s) => s.close);
  const moveMatch = useFindPanelStore((s) => s.moveMatch);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const setT = scheduler?.setTimeout ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const clearT = scheduler?.clearTimeout ?? ((id: number) => window.clearTimeout(id));

  // Debounced recompute. Spec: 150 ms. Clearing the query zeroes matches
  // immediately (store shortcut). Mode toggles flow through the same debounce
  // when non-empty so `\b` / case toggles don't thrash on rapid clicks.
  useEffect(() => {
    if (!open) return;
    if (query.length === 0) {
      // Nothing to do — `setQuery('')` already cleared matches.
      return;
    }
    const handle = setT(() => {
      const emulator = getEmulator();
      if (emulator === null) {
        setMatches([], null);
        return;
      }
      try {
        const hits = searchGridWithQuery(
          emulator,
          { text: query, regex, caseSensitive, wholeWord },
          maxResults !== undefined ? { maxResults } : undefined,
        );
        setMatches(hits, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMatches([], message);
      }
    }, debounceMs);
    return () => clearT(handle);
    // `getEmulator` is a stable callback (caller's contract); mode flags are
    // part of the query identity.
  }, [
    open,
    query,
    regex,
    caseSensitive,
    wholeWord,
    debounceMs,
    maxResults,
    getEmulator,
    setMatches,
    setT,
    clearT,
  ]);

  // Focus the input on open, restore focus on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      const target = previouslyFocused.current;
      if (target && typeof target.focus === 'function') target.focus();
      previouslyFocused.current = null;
    };
  }, [open]);

  // Forward the active match to the canvas for scroll-into-view.
  useEffect(() => {
    if (!open) {
      onScrollToMatch?.(null);
      return;
    }
    if (matches.length === 0) {
      onScrollToMatch?.(null);
      return;
    }
    const current = matches[currentIndex] ?? null;
    onScrollToMatch?.(current);
  }, [open, matches, currentIndex, onScrollToMatch]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (matches.length === 0) return;
        moveMatch(e.shiftKey ? -1 : 1);
      }
      // F3 / Shift+F3 — convention used by Firefox / VS Code.
      if (e.key === 'F3') {
        e.preventDefault();
        if (matches.length === 0) return;
        moveMatch(e.shiftKey ? -1 : 1);
      }
    },
    [close, moveMatch, matches.length],
  );

  const countLabel = useMemo(() => {
    if (query.length === 0) return '';
    if (error !== null) return 'invalid regex';
    if (matches.length === 0) return 'no matches';
    return `${currentIndex + 1} of ${matches.length}`;
  }, [query, matches.length, currentIndex, error]);

  if (!open) return null;

  const hasQuery = query.length > 0;
  const hasError = error !== null && hasQuery;
  const noMatches = hasQuery && matches.length === 0 && !hasError;

  return (
    <div
      role="search"
      aria-label="Find on grid"
      className={styles.panel}
      data-testid="find-panel"
    >
      <div className={styles.row}>
        <span className={styles.icon} aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in output…"
          aria-label="Find in output"
          aria-invalid={hasError ? 'true' : 'false'}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          data-testid="find-panel-input"
        />
        <span className={styles.toggles}>
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setCaseSensitive(!caseSensitive)}
            aria-pressed={caseSensitive ? 'true' : 'false'}
            aria-label="Match case"
            data-active={caseSensitive ? 'true' : 'false'}
            data-testid="find-panel-toggle-case"
          >
            Aa
          </button>
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setWholeWord(!wholeWord)}
            aria-pressed={wholeWord ? 'true' : 'false'}
            aria-label="Whole word"
            data-active={wholeWord ? 'true' : 'false'}
            data-testid="find-panel-toggle-word"
          >
            W
          </button>
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setRegex(!regex)}
            aria-pressed={regex ? 'true' : 'false'}
            aria-label="Use regular expression"
            data-active={regex ? 'true' : 'false'}
            data-testid="find-panel-toggle-regex"
          >
            .*
          </button>
        </span>
        <span
          className={cx(
            styles.count,
            noMatches ? styles.countEmpty : undefined,
            hasError ? styles.countError : undefined,
          )}
          aria-live="polite"
          data-testid="find-panel-count"
        >
          {countLabel}
        </span>
        <button
          type="button"
          className={styles.navBtn}
          onClick={() => moveMatch(-1)}
          disabled={matches.length === 0}
          aria-label="Previous match"
          data-testid="find-panel-prev"
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.navBtn}
          onClick={() => moveMatch(1)}
          disabled={matches.length === 0}
          aria-label="Next match"
          data-testid="find-panel-next"
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={close}
          aria-label="Close find panel"
          data-testid="find-panel-close"
        >
          Esc
        </button>
      </div>
    </div>
  );
}

export const FindPanel = memo(FindPanelImpl);
FindPanel.displayName = 'FindPanel';
