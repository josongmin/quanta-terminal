/**
 * OutputSearch — find-on-page surface for block OUTPUT.
 *
 * Ownership model mirrors the HistorySearch widget: parent toggles `open` via
 * keymap (TerminalPage binds `mod+f` when the history search isn't preferred),
 * the widget handles the input, debounce, navigation, and scrolling.
 *
 * Modes: plain text, regex, case-sensitive, whole-word — all mix-and-matchable
 * via the toggles in the bar. Invalid regex input renders inline as
 * "/invalid regex/" (red) without breaking the widget; flipping the regex
 * toggle off restores a valid plain-text search.
 *
 * Navigation: Enter / F3 → next, Shift+Enter / Shift+F3 → prev. Pressing the
 * nav arrow at either end wraps. The widget scrolls the block containing the
 * current match into view using `scrollIntoView({ block: 'center' })`.
 *
 * Scroll-into-view: we don't maintain a per-block DOM ref registry; each block
 * row in BlockList already carries `data-block-id={id}`, so we look the node
 * up by query selector.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
} from 'react';

import { Kbd } from '../../shared/ui/kbd/index.js';
import { Tooltip } from '../../shared/ui/tooltip/index.js';
import { cx } from '../../shared/lib/cx.js';
import {
  useBlockIds,
  useBlocksForSession,
  useBlockStore,
  type Block,
} from '../../entities/block/index.js';
import {
  buildCrossBlockIndex,
  computeMatches,
  useOutputSearchStore,
  type CrossBlockResult,
  type SearchQuery,
} from '../../features/output-search/index.js';
import { t } from '../../shared/i18n/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';

import styles from './output-search.module.css';

export interface OutputSearchProps {
  /** Narrow the search scope to a single session's blocks; null = all. */
  readonly sessionId?: SessionId | null;
  /** Debounce for the recompute pass, in ms. Defaults to 100 (spec). */
  readonly debounceMs?: number;
  /** Scan-window cap; forwarded to `buildCrossBlockIndex`. */
  readonly maxBlocks?: number;
}

/**
 * Pure recompute helper — exported for tests. Given the latest input, returns
 * the match list the store should be set to. Accepts either the legacy
 * string-query API or the new structured `SearchQuery`.
 */
export function recomputeForQuery(params: {
  readonly ids: readonly string[];
  readonly query: string | SearchQuery;
  readonly getBlock: (id: string) => Block | undefined;
  readonly maxBlocks?: number;
}): CrossBlockResult | ReturnType<typeof computeMatches> {
  const blocks: Block[] = [];
  for (const id of params.ids) {
    const b = params.getBlock(id);
    if (b) blocks.push(b);
  }
  if (typeof params.query === 'string') {
    return computeMatches({ blocks, query: params.query });
  }
  return buildCrossBlockIndex({
    blocks,
    query: params.query,
    ...(params.maxBlocks !== undefined ? { maxBlocks: params.maxBlocks } : {}),
  });
}

function OutputSearchImpl(props: OutputSearchProps) {
  const { sessionId = null, debounceMs = 100, maxBlocks } = props;

  const open = useOutputSearchStore((s) => s.open);
  const query = useOutputSearchStore((s) => s.query);
  const regex = useOutputSearchStore((s) => s.regex);
  const caseSensitive = useOutputSearchStore((s) => s.caseSensitive);
  const wholeWord = useOutputSearchStore((s) => s.wholeWord);
  const matches = useOutputSearchStore((s) => s.matches);
  const currentIndex = useOutputSearchStore((s) => s.currentIndex);
  const error = useOutputSearchStore((s) => s.error);
  const setQuery = useOutputSearchStore((s) => s.setQuery);
  const setRegex = useOutputSearchStore((s) => s.setRegex);
  const setCaseSensitive = useOutputSearchStore((s) => s.setCaseSensitive);
  const setWholeWord = useOutputSearchStore((s) => s.setWholeWord);
  const setMatches = useOutputSearchStore((s) => s.setMatches);
  const close = useOutputSearchStore((s) => s.close);
  const moveMatch = useOutputSearchStore((s) => s.moveMatch);

  // Scope the block id list. `useBlocksForSession(null)` returns the default-
  // session bucket; `useBlockIds()` returns all ids across sessions. For a
  // single-tab Phase-1 UI either produces equivalent results.
  const allIds = useBlockIds();
  const scopedIds = useBlocksForSession(sessionId);
  const ids = sessionId === null ? allIds : scopedIds;

  // `rowSignatures` mirrors the pattern used by BlockList so we re-run the
  // match recompute when any block's output bytes change. Without this, a
  // command that emits matches AFTER the search bar opened wouldn't light up.
  const rowSignatures = useBlockStore((s) => {
    const parts: string[] = [];
    for (const id of ids) {
      const b = s.entities[id];
      if (!b) continue;
      parts.push(`${id}:${b.outputChunks.length}`);
    }
    return parts.join('|');
  });

  const inputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Debounced recompute — spec: 100ms for cross-block. Clearing the query
  // sets matches synchronously (via the store's own shortcut); the debounce
  // only applies to non-empty queries. Toggles (regex / case / word) are
  // treated as part of the query identity so flipping a toggle re-indexes
  // immediately when non-empty.
  useEffect(() => {
    if (!open) return;
    if (query.length === 0) {
      if (matches.length > 0 || error !== null) {
        setMatches({ matches: [], detailed: [], error: null });
      }
      return;
    }
    const handle = window.setTimeout(() => {
      const result = buildCrossBlockIndex({
        blocks: ids
          .map((id) => useBlockStore.getState().entities[id])
          .filter((b): b is Block => b !== undefined),
        query: { text: query, regex, caseSensitive, wholeWord },
        ...(maxBlocks !== undefined ? { maxBlocks } : {}),
      });
      setMatches(result);
    }, debounceMs);
    return () => window.clearTimeout(handle);
    // rowSignatures drives re-index when streaming updates the store; ids
    // drives it when blocks come and go; toggles drive it on mode flips.
  }, [
    open,
    query,
    regex,
    caseSensitive,
    wholeWord,
    ids,
    rowSignatures,
    debounceMs,
    maxBlocks,
    setMatches,
    matches.length,
    error,
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

  // Scroll the block containing the current match into view whenever the
  // active index changes. We scroll the block as a whole; precise line-
  // scrolling would require a ref registry keyed on (blockId, lineIndex)
  // which is deferred until user feedback demands it.
  useEffect(() => {
    if (!open) return;
    if (matches.length === 0) return;
    const current = matches[currentIndex];
    if (!current) return;
    const node = document.querySelector<HTMLElement>(
      `[data-block-id="${current.blockId.replace(/"/g, '\\"')}"]`,
    );
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [open, matches, currentIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      // Enter / F3 → next (Shift reverses). Matches standard Find-on-page.
      if (e.key === 'Enter' || e.key === 'F3') {
        e.preventDefault();
        if (matches.length === 0) return;
        moveMatch(e.shiftKey ? -1 : 1);
      }
    },
    [close, moveMatch, matches.length],
  );

  const countLabel = useMemo(() => {
    if (query.length === 0) return '';
    if (error !== null) return t('outputSearch.invalidRegex');
    if (matches.length === 0) return t('outputSearch.countNone');
    return t('outputSearch.countOf', {
      current: currentIndex + 1,
      total: matches.length,
    });
  }, [query, matches.length, currentIndex, error]);

  if (!open) return null;

  const hasQuery = query.length > 0;
  const noMatches = hasQuery && matches.length === 0 && error === null;
  const hasError = error !== null && hasQuery;

  return (
    <div
      role="search"
      aria-label={t('outputSearch.regionLabel')}
      className={styles.bar}
      data-testid="output-search-bar"
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
          placeholder={t('outputSearch.placeholder')}
          aria-label={t('outputSearch.ariaLabel')}
          aria-controls="quanta-output-search-results"
          aria-invalid={hasError ? 'true' : 'false'}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          data-testid="output-search-input"
        />
        <span className={styles.toggles}>
          <Tooltip content={<>{t('outputSearch.toggleCaseTooltip')}</>}>
            <button
              type="button"
              className={styles.toggle}
              onClick={() => setCaseSensitive(!caseSensitive)}
              aria-pressed={caseSensitive ? 'true' : 'false'}
              aria-label={t('outputSearch.toggleCaseTooltip')}
              data-active={caseSensitive ? 'true' : 'false'}
              data-testid="output-search-toggle-case"
            >
              {t('outputSearch.toggleCase')}
            </button>
          </Tooltip>
          <Tooltip content={<>{t('outputSearch.toggleWordTooltip')}</>}>
            <button
              type="button"
              className={styles.toggle}
              onClick={() => setWholeWord(!wholeWord)}
              aria-pressed={wholeWord ? 'true' : 'false'}
              aria-label={t('outputSearch.toggleWordTooltip')}
              data-active={wholeWord ? 'true' : 'false'}
              data-testid="output-search-toggle-word"
            >
              {t('outputSearch.toggleWord')}
            </button>
          </Tooltip>
          <Tooltip content={<>{t('outputSearch.toggleRegexTooltip')}</>}>
            <button
              type="button"
              className={styles.toggle}
              onClick={() => setRegex(!regex)}
              aria-pressed={regex ? 'true' : 'false'}
              aria-label={t('outputSearch.toggleRegexTooltip')}
              data-active={regex ? 'true' : 'false'}
              data-testid="output-search-toggle-regex"
            >
              .*
            </button>
          </Tooltip>
        </span>
        <span
          className={cx(
            styles.count,
            noMatches ? styles.countEmpty : undefined,
            hasError ? styles.countError : undefined,
          )}
          id="quanta-output-search-results"
          aria-live="polite"
          data-testid="output-search-count"
        >
          {countLabel}
        </span>
        <button
          type="button"
          className={styles.navBtn}
          onClick={() => moveMatch(-1)}
          disabled={matches.length === 0}
          aria-label={t('outputSearch.prev')}
          data-testid="output-search-prev"
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.navBtn}
          onClick={() => moveMatch(1)}
          disabled={matches.length === 0}
          aria-label={t('outputSearch.next')}
          data-testid="output-search-next"
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={close}
          aria-label={t('outputSearch.close')}
          data-testid="output-search-close"
        >
          <Kbd>Esc</Kbd>
        </button>
      </div>
      <div
        className={cx(styles.hint, hasError ? styles.hintError : undefined)}
        data-testid="output-search-hint"
      >
        <span>{hasError ? error : t('outputSearch.hint')}</span>
      </div>
    </div>
  );
}

export const OutputSearch = memo(OutputSearchImpl);
OutputSearch.displayName = 'OutputSearch';
