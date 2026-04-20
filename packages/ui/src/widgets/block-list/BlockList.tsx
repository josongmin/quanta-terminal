/**
 * BlockList — row-range virtualization anchored via `cellToScreen`.
 *
 * EPIC-H redesign (§4.1): the virtualizer now operates on ROWS (in grid row
 * coordinates), not on block entities. Each block occupies a `RowRange`
 * { blockId, startRow, endExclusive }. The row ranges are derived once per
 * render from the current block list — for blocks, we approximate row
 * height as the visible-line count of output (`\n` bytes + 1 chrome row)
 * with a floor of 1 row.
 *
 * Why row-range virtualization (RFC §7.7 / EPIC-H §4.1.1):
 *   - Selection across blocks used to misalign because the virtualizer
 *     thought each block was its own item; dragging across the boundary
 *     produced a gap in the copied text.
 *   - Scrollback replay mounted N block cards sequentially rather than
 *     letting the virtualizer skip off-screen rows.
 *   - Block chrome drifted from the cell grid because the DOM layout used
 *     flex spacing while the grid used fixed cell metrics.
 *
 * Block chrome is rendered as an absolutely-positioned overlay on top of
 * the virtualized surface. The overlay reads `cellToScreen(startRow, 0).y`
 * — injected via `cellToScreen` prop, or defaulted to the `DEFAULT_METRICS`
 * math when the prop is omitted (tests, isolated rendering). The Warp-style
 * cards the user sees are those overlays.
 *
 * Auto-scroll rules (unchanged from the prior design):
 *   - When a new block is created, scroll to the end.
 *   - When the running block's output grows and the user is already "near
 *     the bottom" (within AUTO_SCROLL_THRESHOLD_PX), keep pinning to end.
 *   - If the user scrolled up, do not yank them back.
 *
 * Tests drive this component in jsdom where layout is zero-sized. The
 * virtualizer degrades gracefully — `scrollToIndex` is a no-op on a zero-
 * height container — so the autoscroll heuristic is unit-tested via the
 * exported `shouldAutoscroll` helper and e2e is covered by live usage.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Kbd } from '../../shared/ui/kbd/index.js';
// Cross-slice: BlockList composes BlockCard. Both are block-domain widgets;
// splitting them into entities/ would coerce a presentational component into
// a non-presentational layer, and moving BlockCard into shared/ would force
// it to know about the block entity type from a lower layer than itself.
// FIXME(fsd-layer-skip): block-list widget composes sibling block-card widget
import { BlockCard } from '../block-card/index.js';
import { useBlock, useBlockIds, useBlocksForSession, useBlockStore } from '../../entities/block/index.js';
import { DEFAULT_METRICS } from '../../shared/ui/cell-renderer/index.js';
import type { Rect } from '../../shared/ui/cell-renderer/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { t } from '../../shared/i18n/index.js';
import styles from './block-list.module.css';

export interface BlockListProps {
  /**
   * Optional session scope. When provided, only blocks that belong to this
   * session render in the list.
   */
  readonly sessionId?: SessionId | null;
  readonly onRerun?: (blockId: string) => void;
  readonly onCopy?: (blockId: string, scope: 'command' | 'output') => void;
  /** Phase 4 — opens the Compare panel when a card's Compare button fires. */
  readonly onCompare?: (blockId: string) => void;
  /**
   * EPIC-H §4.1: forward-map from (row, col) to a pixel rect. The block
   * chrome overlay uses `cellToScreen(startRow, 0).y` to anchor the top
   * of each card. When omitted, a default metric is used so tests and
   * pre-mount flows still render correctly.
   */
  readonly cellToScreen?: (row: number, col: number) => Rect;
}

/** If the user is within this many pixels of the bottom, we treat them as
 *  "following the stream" and keep autoscrolling. */
const AUTO_SCROLL_THRESHOLD_PX = 64;

/**
 * Row-height floor used when the virtualizer asks `estimateSize(i)` for a
 * row we haven't measured yet. The default metric (16 px) keeps the offset
 * math coherent with `cellToScreen`.
 */
const ESTIMATED_ROW_HEIGHT_PX = DEFAULT_METRICS.cellHeightCssPx;

/** Minimum chrome height before we subtract body content. */
const BLOCK_CHROME_MIN_ROWS = 3;

function defaultCellToScreen(row: number, col: number): Rect {
  return {
    x: col * DEFAULT_METRICS.cellWidthCssPx,
    y: row * DEFAULT_METRICS.cellHeightCssPx,
    width: DEFAULT_METRICS.cellWidthCssPx,
    height: DEFAULT_METRICS.cellHeightCssPx,
  };
}

/**
 * Pure autoscroll rule — exported for tests. Returns true when we should
 * pin the viewport to the last block: either the block count grew (a new
 * block was just created) OR the user is near the bottom.
 */
export function shouldAutoscroll(params: {
  readonly prevCount: number;
  readonly nextCount: number;
  readonly distanceFromBottom: number;
  readonly threshold: number;
}): boolean {
  if (params.nextCount > params.prevCount) return true;
  return params.distanceFromBottom <= params.threshold;
}

/* ------------------------------------------------------------------------ */
/*  Row-range math                                                           */
/* ------------------------------------------------------------------------ */

/**
 * A contiguous run of rows belonging to one block in the virtualized list.
 * `startRow` is inclusive (0-based from the top of the scroll surface),
 * `endExclusive` is the first row NOT in this block.
 */
export interface RowRange {
  readonly blockId: string;
  readonly startRow: number;
  readonly endExclusive: number;
}

/** Binary search: which `ranges` entry covers `row`? -1 if out-of-range. */
export function findRangeForRow(ranges: readonly RowRange[], row: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (!r) break;
    if (row < r.startRow) {
      hi = mid - 1;
    } else if (row >= r.endExclusive) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

/** Estimate the number of rows a block occupies in the row-range model. */
function rowsForBlock(chunks: readonly Uint8Array[], collapsed: boolean): number {
  if (collapsed) return BLOCK_CHROME_MIN_ROWS;
  let newlines = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.byteLength; i += 1) {
      if (chunk[i] === 0x0a) newlines += 1;
    }
  }
  // +1 row for the trailing partial line (if any) capped at a sane minimum.
  return Math.max(BLOCK_CHROME_MIN_ROWS, newlines + BLOCK_CHROME_MIN_ROWS);
}

/* ------------------------------------------------------------------------ */
/*  Component                                                                */
/* ------------------------------------------------------------------------ */

function BlockRowChrome(props: {
  readonly id: string;
  readonly onRerun?: (blockId: string) => void;
  readonly onCopy?: (blockId: string, scope: 'command' | 'output') => void;
  readonly onCompare?: (blockId: string) => void;
}) {
  const { id, onRerun, onCopy, onCompare } = props;
  const block = useBlock(id);
  if (!block) return null;
  return (
    <div className={styles.row} data-block-id={id}>
      <BlockCard
        block={block}
        {...(onRerun ? { onRerun } : {})}
        {...(onCopy ? { onCopy } : {})}
        {...(onCompare ? { onCompare } : {})}
      />
    </div>
  );
}

export function BlockList(props: BlockListProps) {
  const { onRerun, onCopy, onCompare, sessionId, cellToScreen = defaultCellToScreen } = props;
  // Both hooks run on every render regardless of the `sessionId` prop — React's
  // rules-of-hooks forbid conditional calls. The unused return value is cheap
  // (shallow-compared, one array reference).
  const allIds = useBlockIds();
  const scopedIds = useBlocksForSession(sessionId ?? null);
  const ids = sessionId === undefined ? allIds : scopedIds;

  // Subscribe to the full store ONCE so the row-range math re-computes when
  // any block's chunks or collapsed-state changes. Per-block updates
  // invalidate the memo only if the block is in scope — cheap for typical
  // session sizes.
  const rowSignatures = useBlockStore((s) => {
    const parts: string[] = [];
    for (const id of ids) {
      const b = s.entities[id];
      if (!b) continue;
      parts.push(`${id}:${b.outputChunks.length}:${b.collapsed ? 'c' : 'e'}`);
    }
    return parts.join('|');
  });

  const ranges = useMemo<RowRange[]>(() => {
    const state = useBlockStore.getState();
    const out: RowRange[] = [];
    let cursor = 0;
    for (const id of ids) {
      const b = state.entities[id];
      if (!b) continue;
      const span = rowsForBlock(b.outputChunks, b.collapsed);
      out.push({ blockId: id, startRow: cursor, endExclusive: cursor + span });
      cursor += span;
    }
    return out;
    // rowSignatures is the authoritative trigger; ids is already baked into it.
  }, [ids, rowSignatures]);

  const totalRows = ranges.length > 0 ? ranges[ranges.length - 1]!.endExclusive : 0;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(ids.length);

  const estimateSize = useCallback(
    (rowIndex: number) => {
      // When we can, use `cellToScreen` so the row heights match the cell
      // grid pixel-for-pixel. Falling back to the default metric preserves
      // layout in jsdom (where the backend reports 0).
      const rect = cellToScreen(rowIndex, 0);
      return rect.height > 0 ? rect.height : ESTIMATED_ROW_HEIGHT_PX;
    },
    [cellToScreen],
  );

  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: DEFAULT_METRICS.cellHeightCssPx * 2,
    getItemKey: (index) => index,
  });

  // Autoscroll — run AFTER render so the virtualizer has the new total size.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      prevCountRef.current = ids.length;
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pin = shouldAutoscroll({
      prevCount: prevCountRef.current,
      nextCount: ids.length,
      distanceFromBottom: distance,
      threshold: AUTO_SCROLL_THRESHOLD_PX,
    });
    prevCountRef.current = ids.length;
    if (pin && totalRows > 0) {
      virtualizer.scrollToIndex(totalRows - 1, { align: 'end' });
    }
  }, [ids.length, totalRows, virtualizer]);

  // ResizeObserver rAF batching — mirrors the prior behaviour for streaming
  // output keeping the view pinned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const inner = el.firstElementChild;
    if (!inner) return;

    let rafId = 0;
    const scheduleCheck = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distance <= AUTO_SCROLL_THRESHOLD_PX && totalRows > 0) {
          virtualizer.scrollToIndex(totalRows - 1, { align: 'end' });
        }
      });
    };
    const ro = new ResizeObserver(scheduleCheck);
    ro.observe(inner);
    return () => {
      ro.disconnect();
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, [totalRows, virtualizer]);

  if (ids.length === 0) {
    return (
      <div
        ref={scrollRef}
        className={styles.scroll}
        data-testid="block-list-empty"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('blockList.ariaLabel')}
      >
        <div className={styles.empty}>
          <div>{t('blockList.empty')}</div>
          <div className={styles.emptyHint}>
            Press <Kbd>Enter</Kbd> to submit.
          </div>
        </div>
      </div>
    );
  }

  // Virtualization disabled — we render every in-scope block as a flex
  // child. Row-range math, `cellToScreen` anchoring, and overscan are no
  // longer needed. The ids list is already scoped to the active session
  // (via `useBlocksForSession` / `useBlockIds`), so this is O(n) in the
  // number of blocks the user has produced for the tab. Keeping the
  // virtualizer call for its autoscroll side-effect would be silly; we
  // just pin-scroll in the effect above.
  void virtualizer; // keep the hook alive for the scroll-pin side effect
  void ranges; // row-range math unused but retained for tests + future perf
  void totalRows;

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      data-testid="block-list"
      data-total-rows={totalRows}
      aria-live="polite"
      aria-relevant="additions"
      aria-label={t('blockList.ariaLabel')}
    >
      <div className={styles.inner} data-testid="block-list-inner">
        {ids.map((id) => (
          <BlockRowChrome
            key={id}
            id={id}
            {...(onRerun ? { onRerun } : {})}
            {...(onCopy ? { onCopy } : {})}
            {...(onCompare ? { onCompare } : {})}
          />
        ))}
      </div>
    </div>
  );
}

BlockList.displayName = 'BlockList';
