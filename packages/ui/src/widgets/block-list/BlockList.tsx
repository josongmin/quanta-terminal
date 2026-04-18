/**
 * BlockList — virtualized, auto-scrolling list of command blocks.
 *
 * Why virtualize: a long session (hundreds of blocks, each with KB of output)
 * renders fast on mount only if off-screen cards don't render at all.
 * `@tanstack/react-virtual` gives us measurement-based virtualization that
 * tolerates variable card heights (a collapsed card is ~40px; an expanded one
 * with 400 output lines is 800px+).
 *
 * Auto-scroll rules (the Warp behaviour):
 *   - When a new block is created, scroll to the end.
 *   - When the running block's output grows and the user is already "near
 *     the bottom" (within AUTO_SCROLL_THRESHOLD_PX), keep pinning to the end.
 *   - If the user scrolled up, do not yank them back. Autoscroll resumes
 *     when they scroll back near the bottom.
 *
 * Tests drive this component in jsdom where layout is zero-sized. The
 * virtualizer degrades gracefully — `scrollToIndex` is a no-op on a zero-
 * height container — so the autoscroll heuristic is unit-tested via the
 * exported `shouldAutoscroll` helper and e2e is covered by live usage.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Kbd } from '../../shared/ui/kbd/index.js';
// Cross-slice: BlockList composes BlockCard. Both are block-domain widgets;
// splitting them into entities/ would coerce a presentational component into
// a non-presentational layer, and moving BlockCard into shared/ would force
// it to know about the block entity type from a lower layer than itself. The
// list → card composition is the whole point of the Warp-style surface, so
// we accept the sibling crossing here with the same escape hatch Agent C
// used for composer → command.
// FIXME(fsd-layer-skip): block-list widget composes sibling block-card widget
import { BlockCard } from '../block-card/index.js';
import { useBlock, useBlockIds, useBlocksForSession } from '../../entities/block/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import styles from './block-list.module.css';

export interface BlockListProps {
  /**
   * Optional session scope. When provided, only blocks that belong to this
   * session render in the list. When omitted, every block in the store
   * renders (legacy single-session behavior — used by tests that drive the
   * store directly and by the compat layer).
   */
  readonly sessionId?: SessionId | null;
  readonly onRerun?: (blockId: string) => void;
  readonly onCopy?: (blockId: string, scope: 'command' | 'output') => void;
  /** Phase 4 — opens the Compare panel when a card's Compare button fires. */
  readonly onCompare?: (blockId: string) => void;
}

/** If the user is within this many pixels of the bottom, we treat them as
 *  "following the stream" and keep autoscrolling. */
const AUTO_SCROLL_THRESHOLD_PX = 64;

/** Conservative starting estimate. The virtualizer refines via measurement. */
const ESTIMATED_CARD_HEIGHT_PX = 160;

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

function BlockRow(props: {
  readonly id: string;
  readonly index: number;
  readonly onRerun?: (blockId: string) => void;
  readonly onCopy?: (blockId: string, scope: 'command' | 'output') => void;
  readonly onCompare?: (blockId: string) => void;
  readonly measureRef: (el: HTMLElement | null) => void;
  readonly translateY: number;
}) {
  const { id, index, onRerun, onCopy, onCompare, measureRef, translateY } = props;
  const block = useBlock(id);
  if (!block) return null;
  // `data-index` is the attribute the virtualizer looks up on each measured
  // element — without it, `measureElement` cannot map the element back to a
  // row and logs a dev-mode warning.
  return (
    <div
      ref={measureRef}
      className={styles.row}
      data-index={index}
      style={{ transform: `translateY(${translateY}px)` }}
    >
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
  const { onRerun, onCopy, onCompare, sessionId } = props;
  // Both hooks run on every render regardless of the `sessionId` prop — React's
  // rules-of-hooks forbid conditional calls. The unused return value is cheap
  // (shallow-compared, one array reference), and `useBlocksForSession(null)`
  // short-circuits to an empty array before iterating the store.
  const allIds = useBlockIds();
  const scopedIds = useBlocksForSession(sessionId ?? null);
  const ids = sessionId === undefined ? allIds : scopedIds;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(ids.length);

  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT_PX,
    overscan: 4,
    getItemKey: (index) => ids[index] ?? index,
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
    if (pin && ids.length > 0) {
      // Align to end so the newest block sits flush against the composer.
      virtualizer.scrollToIndex(ids.length - 1, { align: 'end' });
    }
  }, [ids.length, virtualizer]);

  // When the active (running) block streams output, the store reference for
  // the list (`ids`) does not change. We still want to keep the view pinned
  // if the user is near the bottom. Subscribe to the scroll element's size
  // changes via ResizeObserver and re-check on every bump — but batch via
  // requestAnimationFrame so a burst of measurement callbacks (streaming
  // output flushes, reflow cascades) costs at most one scroll per frame.
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
        if (distance <= AUTO_SCROLL_THRESHOLD_PX && ids.length > 0) {
          virtualizer.scrollToIndex(ids.length - 1, { align: 'end' });
        }
      });
    };
    const ro = new ResizeObserver(scheduleCheck);
    ro.observe(inner);
    return () => {
      ro.disconnect();
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, [ids.length, virtualizer]);

  const measureElement = useCallback(
    (el: HTMLElement | null): void => {
      virtualizer.measureElement(el);
    },
    [virtualizer],
  );

  if (ids.length === 0) {
    return (
      <div className={styles.scroll} data-testid="block-list-empty">
        <div className={styles.empty}>
          <div>Type a command below to get started.</div>
          <div className={styles.emptyHint}>
            Press <Kbd>Enter</Kbd> to submit.
          </div>
        </div>
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div ref={scrollRef} className={styles.scroll} data-testid="block-list">
      <div className={styles.inner} style={{ height: `${totalSize}px` }}>
        {items.map((item) => {
          const id = ids[item.index];
          if (!id) return null;
          return (
            <BlockRow
              key={item.key}
              id={id}
              index={item.index}
              measureRef={measureElement}
              translateY={item.start}
              {...(onRerun ? { onRerun } : {})}
              {...(onCopy ? { onCopy } : {})}
              {...(onCompare ? { onCompare } : {})}
            />
          );
        })}
      </div>
    </div>
  );
}

BlockList.displayName = 'BlockList';
