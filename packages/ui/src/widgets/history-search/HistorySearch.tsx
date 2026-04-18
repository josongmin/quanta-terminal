/**
 * HistorySearch — centered modal, Cmd/Ctrl+F to open.
 *
 * Visually adjacent to the command palette (same motion tokens, same backdrop
 * blur) but wider and using a mono font in the result list — history is
 * command text and cwd paths, not natural-language labels.
 *
 * Behavior:
 *   - typing updates the BM25-ranked result list in-line (no debounce needed
 *     at <= 2000 blocks; ADR budget is 50ms);
 *   - ArrowUp/ArrowDown move the selection, wrap at the ends;
 *   - Enter fires `onSelect(block)` — the parent page scrolls the block into
 *     view and closes the panel;
 *   - Escape closes; outside-click closes;
 *   - empty query renders a hint, not results (history sitting silent is the
 *     right affordance — matches ADR "this is a search surface, not a list");
 *   - hit highlighting marks every matched query token in the command line.
 *
 * Ownership: open/close is controlled by the parent (same pattern as the
 * command palette). The widget itself only knows how to render.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';

import { Kbd } from '../../shared/ui/kbd/index.js';
import { Badge } from '../../shared/ui/badge/index.js';
import { Spinner } from '../../shared/ui/spinner/index.js';
import { cx } from '../../shared/lib/cx.js';
import { activateFocusTrap } from '../../shared/lib/focus-trap.js';
import { useBlockIds, useBlockStore, type Block } from '../../entities/block/index.js';
// FIXME(fsd-layer-skip): history widget depends on the history feature for ranking
import {
  prepareIndex,
  searchHistoryPrepared,
  tokenize,
  type SearchHit,
} from '../../features/history/index.js';

import styles from './history-search.module.css';

export interface HistorySearchProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect?: (block: Block, hit: SearchHit) => void;
  /** Override the result limit. Default 20 — the ADR's global-search default. */
  readonly limit?: number;
  /** Whether the caller is still hydrating from persistence. When true, we
   *  show a tiny spinner in the footer so a brief empty-state isn't confused
   *  with "no history". */
  readonly hydrating?: boolean;
}

export function HistorySearch(props: HistorySearchProps) {
  const { open, onClose, onSelect, limit = 20, hydrating = false } = props;
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const ids = useBlockIds();

  // Build the prepared index against the current id set. Subscribing to
  // `entities` directly would rebuild the BM25 index on EVERY streamed chunk
  // (because `appendBlockOutput` replaces the block reference, which in turn
  // mints a new `entities` map). BM25 inputs are `command + output tokens +
  // diagnostic` — stable once the block has completed, and for in-flight
  // blocks the command + cwd tokens are enough to make the search reachable.
  // We therefore take a one-shot snapshot at the moment `ids` changes (new
  // block appeared or re-ordered) and pull current block objects from
  // `getState()` without subscribing. `open` is included in the dep list so
  // that reopening the panel always sees the latest headers — covers the
  // edge case where a block completes silently while the panel was closed.
  const prepared = useMemo(() => {
    const state = useBlockStore.getState();
    const blocks: Block[] = [];
    for (const id of ids) {
      const b = state.entities[id];
      if (b) blocks.push(b);
    }
    return prepareIndex(blocks);
    // `open` drives a re-grab when the panel transitions from closed to open
    // without changing `ids` — typical when the user searches right after a
    // long-running block finished in the background.
  }, [ids, open]);

  const hits = useMemo(() => {
    if (query.trim().length === 0) return [];
    return searchHistoryPrepared(prepared, query, { limit });
  }, [prepared, query, limit]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    if (!container) return;
    inputRef.current?.focus();
    const trap = activateFocusTrap(container);
    return () => {
      trap.deactivate();
      setQuery('');
      const target = previouslyFocused.current;
      if (target && typeof target.focus === 'function') {
        target.focus();
      }
      previouslyFocused.current = null;
    };
  }, [open]);

  const runAt = useCallback(
    (index: number) => {
      const hit = hits[index];
      if (!hit) return;
      onSelect?.(hit.block, hit);
      onClose();
    },
    [hits, onClose, onSelect],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (hits.length === 0) return;
        setActiveIndex((i) => (i + 1) % hits.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (hits.length === 0) return;
        setActiveIndex((i) => (i - 1 + hits.length) % hits.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        runAt(activeIndex);
      }
    },
    [activeIndex, hits.length, onClose, runAt],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={handleBackdropClick}
      data-testid="history-search-backdrop"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="History search"
        className={styles.panel}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.inputRow}>
          <span className={styles.inputIcon} aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search command history"
            aria-label="Search command history"
            aria-controls="quanta-history-results"
            aria-activedescendant={
              hits[activeIndex] ? `quanta-history-opt-${hits[activeIndex].block.id}` : undefined
            }
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div
          id="quanta-history-results"
          className={styles.results}
          role="listbox"
          aria-label="History results"
        >
          {query.trim().length === 0 ? (
            <div className={styles.empty} role="status">
              Type to search past commands. {hydrating ? 'Loading history…' : ''}
            </div>
          ) : hits.length === 0 ? (
            <div className={styles.empty} role="status">
              No matches for &ldquo;{query}&rdquo;.
            </div>
          ) : (
            <ul className={styles.sectionList}>
              {hits.map((hit, idx) => (
                <HistoryRow
                  key={hit.block.id}
                  hit={hit}
                  query={query}
                  active={idx === activeIndex}
                  onHover={() => setActiveIndex(idx)}
                  onClick={() => runAt(idx)}
                />
              ))}
            </ul>
          )}
        </div>
        <div className={styles.footer}>
          <div>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> to navigate · <Kbd>⏎</Kbd> open · <Kbd>Esc</Kbd> close
          </div>
          <div>
            {hydrating ? (
              <Spinner size="sm" label="Hydrating history" />
            ) : (
              <span>{hits.length} result{hits.length === 1 ? '' : 's'}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

HistorySearch.displayName = 'HistorySearch';

interface HistoryRowProps {
  readonly hit: SearchHit;
  readonly query: string;
  readonly active: boolean;
  readonly onHover: () => void;
  readonly onClick: () => void;
}

function HistoryRow(props: HistoryRowProps) {
  const { hit, query, active, onHover, onClick } = props;
  const tokens = useMemo(() => tokenize(query), [query]);
  return (
    <li
      id={`quanta-history-opt-${hit.block.id}`}
      role="option"
      aria-selected={active}
      className={cx(styles.row, active && styles.rowActive)}
      onMouseEnter={onHover}
      onClick={onClick}
    >
      <div className={styles.rowHeader}>
        <span className={styles.command}>{highlight(hit.block.command, tokens)}</span>
        {hit.block.pinned ? <Badge label="pinned" tone="accent" /> : null}
        {hit.duplicateCount > 1 ? (
          <Badge label={`${hit.duplicateCount}×`} tone="neutral" />
        ) : null}
      </div>
      <div className={styles.meta}>
        <span className={styles.metaCwd}>{hit.block.cwd}</span>
        <span>{statusLabel(hit.block)}</span>
        <span>{formatTimeAgo(hit.block.completedAt ?? hit.block.startedAt)}</span>
      </div>
    </li>
  );
}

function statusLabel(b: Block): string {
  if (b.status === 'error') return 'error';
  if (b.status === 'canceled') return 'canceled';
  if (b.exitCode === 0) return 'exit 0';
  if (b.exitCode !== null) return `exit ${b.exitCode}`;
  return b.status;
}

function formatTimeAgo(ts: number | null): string {
  if (ts === null) return 'now';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Highlight every matched query token inside the given text. Case-insensitive.
 * Output is a list of React nodes to mix into the row's command line.
 */
function highlight(text: string, tokens: readonly string[]): React.ReactNode {
  if (tokens.length === 0 || text.length === 0) return text;
  const lower = text.toLowerCase();
  // Mark the match spans, merging overlapping matches.
  interface Span {
    readonly start: number;
    readonly end: number;
  }
  const spans: Span[] = [];
  for (const t of tokens) {
    if (t.length === 0) continue;
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(t, from);
      if (idx < 0) break;
      spans.push({ start: idx, end: idx + t.length });
      from = idx + t.length;
    }
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, s.end) };
    } else {
      merged.push(s);
    }
  }
  const out: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach((s, i) => {
    if (cursor < s.start) out.push(text.slice(cursor, s.start));
    out.push(
      <mark key={`h${i}`} className={styles.commandHit}>
        {text.slice(s.start, s.end)}
      </mark>,
    );
    cursor = s.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
