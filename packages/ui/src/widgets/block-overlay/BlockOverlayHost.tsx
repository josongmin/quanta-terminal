/**
 * Plan 0005 P1-C — BlockOverlayHost.
 *
 * Thin store-binding wrapper around `BlockOverlay`. Subscribes to the
 * session-scoped block list and to the active emulator's scrollback
 * window; forwards a projection-ready `BlockOverlayItem[]` plus cell
 * geometry to `BlockOverlay`.
 *
 * The split keeps `BlockOverlay.tsx` pure (no store access, no bridge
 * lookup) so it can be unit-tested with plain fixtures.
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { useBlockStore } from '../../entities/block/index.js';
import type { Block } from '../../entities/block/index.js';
import { DEFAULT_METRICS } from '../../shared/ui/cell-renderer/index.js';
import { getSessionConnection } from '../../features/session-tabs/index.js';
import type { ConnectedSession } from '../../features/session/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { BlockOverlay } from './BlockOverlay.js';
import type { BlockOverlayItem } from './BlockOverlay.js';
import { EvictionBanner } from './EvictionBanner.js';

export interface BlockOverlayHostProps {
  readonly sessionId: SessionId | null;
  /** Override the default cell height — used by tests that don't want to
   *  stand up the whole renderer metrics plumbing. */
  readonly cellHeightPx?: number;
}

interface ScrollbackWindow {
  readonly baseRowId: number;
  readonly rowCount: number;
  /** Polished pass surface: pin-blocked eviction counter + head-pin count so
   *  the eviction banner can render without a second subscribe path. */
  readonly pinBlockedEvictions: number;
  readonly pinnedRowCount: number;
  readonly cols: number;
}

function readScrollbackWindow(
  session: ConnectedSession | undefined,
): ScrollbackWindow {
  // Defensive: some session shapes in tests don't expose an engine handle.
  // Fall back to a null window (baseRowId 0, rowCount 0) so the overlay
  // renders no cards but stays mounted for the caller's observation.
  if (session === undefined) {
    return {
      baseRowId: 0,
      rowCount: 0,
      pinBlockedEvictions: 0,
      pinnedRowCount: 0,
      cols: 0,
    };
  }
  const emulator = session.engine?.emulator;
  if (!emulator || typeof emulator.getScrollback !== 'function') {
    return {
      baseRowId: 0,
      rowCount: 0,
      pinBlockedEvictions: 0,
      pinnedRowCount: 0,
      cols: 0,
    };
  }
  try {
    const ring = emulator.getScrollback();
    // Count pinned rows at the HEAD of the ring — that's what blocks
    // eviction. A pin further down the ring has zero effect on capacity
    // (the ring just chops rows above it). We walk from index 0 until
    // the first unpinned row so N reflects the real "cannot evict until
    // these clear" count. Defensive against sparse rows / test mocks that
    // return plain `new Array(N)` (holes read as `undefined`).
    let pinnedHead = 0;
    const rows = ring.rows;
    if (Array.isArray(rows)) {
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        if (r !== undefined && r !== null && r.pinned === true) {
          pinnedHead += 1;
        } else {
          break;
        }
      }
    }
    const cols =
      typeof emulator.getDimensions === 'function'
        ? emulator.getDimensions().cols
        : 0;
    return {
      baseRowId: ring.baseRowId ?? 0,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      pinBlockedEvictions: ring.pinBlockedEvictions ?? 0,
      pinnedRowCount: pinnedHead,
      cols,
    };
  } catch {
    return {
      baseRowId: 0,
      rowCount: 0,
      pinBlockedEvictions: 0,
      pinnedRowCount: 0,
      cols: 0,
    };
  }
}

/**
 * A cheap reactive read for the scrollback window. We can't subscribe to
 * VtEmulator state directly (it doesn't expose a subscriber surface for
 * scrollback drift), so we poll on rAF via `useSyncExternalStore`. The
 * overlay re-renders at most once per frame anyway; there's no user-
 * visible cost to reading on every subscribe tick.
 */
function subscribeRaf(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    // SSR / node-test fallback — tick on an interval so polls still
    // advance the subscription.
    const t = setInterval(callback, 250);
    return () => clearInterval(t);
  }
  let handle = window.requestAnimationFrame(function loop() {
    callback();
    handle = window.requestAnimationFrame(loop);
  });
  return () => window.cancelAnimationFrame(handle);
}

/**
 * Cache the last returned scrollback-window so `useSyncExternalStore` gets
 * reference-stable snapshots when nothing changed. Without this cache
 * every poll would allocate a fresh object and React would tear the
 * subscription forever. Keyed by sessionId so a session switch invalidates
 * the cache deterministically.
 */
const windowCache = new Map<string, ScrollbackWindow>();

function scrollbackSnapshot(sessionId: SessionId | null): ScrollbackWindow {
  if (sessionId === null) {
    return {
      baseRowId: 0,
      rowCount: 0,
      pinBlockedEvictions: 0,
      pinnedRowCount: 0,
      cols: 0,
    };
  }
  const conn = getSessionConnection(sessionId);
  const next = readScrollbackWindow(conn);
  const cached = windowCache.get(sessionId);
  if (
    cached !== undefined &&
    cached.baseRowId === next.baseRowId &&
    cached.rowCount === next.rowCount &&
    cached.pinBlockedEvictions === next.pinBlockedEvictions &&
    cached.pinnedRowCount === next.pinnedRowCount &&
    cached.cols === next.cols
  ) {
    return cached;
  }
  windowCache.set(sessionId, next);
  return next;
}

/**
 * Produce the slim overlay view from a `Block`. Blocks without a row
 * range are filtered OUT upstream; this function requires the range to
 * be present.
 */
function toOverlayItem(block: Block): BlockOverlayItem | null {
  if (block.rowRange === null) return null;
  return {
    id: block.id,
    command: block.command,
    status: block.status,
    exitCode: block.exitCode,
    cwd: block.cwd,
    rowRange: block.rowRange,
    confidence: block.confidence,
    durationMs: block.durationMs,
    startedAt: block.startedAt,
    completedAt: block.completedAt,
  };
}

export function BlockOverlayHost(props: BlockOverlayHostProps): JSX.Element | null {
  const { sessionId, cellHeightPx: overrideCellHeight } = props;

  // Subscribe to the block store's order + entities. `useBlockStore` is
  // the whole-store hook; we derive a session-scoped projection in a
  // single render pass so the overlay re-renders only when the projection
  // actually changes. Zustand's shallow compare happens upstream via
  // `useShallow` — we mirror that here with `useMemo` keyed on the raw
  // state inputs.
  const order = useBlockStore((s) => s.order);
  const entities = useBlockStore((s) => s.entities);

  const items = useMemo<readonly BlockOverlayItem[]>(() => {
    const out: BlockOverlayItem[] = [];
    for (const id of order) {
      const b = entities[id];
      if (!b) continue;
      if (sessionId !== null && b.sessionId !== sessionId) continue;
      const item = toOverlayItem(b);
      if (item !== null) out.push(item);
    }
    return out;
  }, [order, entities, sessionId]);

  const window = useSyncExternalStore(
    subscribeRaf,
    () => scrollbackSnapshot(sessionId),
    () => scrollbackSnapshot(sessionId),
  );

  const cellHeightPx = overrideCellHeight ?? DEFAULT_METRICS.cellHeightCssPx;

  // Approximate freeable bytes when the pinned head rows get released.
  // `BYTES_PER_CELL` is a conservative estimate of a cloned scrollback row's
  // cell footprint — the real cost varies with V8 hidden-class layout,
  // SGR breadth, and grapheme payload, but within a 2-3x factor of this.
  // The banner underestimates rather than overestimates so the copy reads
  // "Unpinning will free ≈ X MB" honestly.
  const BYTES_PER_CELL = 48;
  const freeableBytes =
    window.pinnedRowCount * Math.max(1, window.cols) * BYTES_PER_CELL;

  // When there are no items AND no pin pressure, return null so the
  // overlay doesn't leak an empty positioned div into the DOM. The
  // eviction banner is load-bearing when pins have blocked — we keep the
  // overlay mounted so the banner has somewhere to render even if no
  // block cards are visible.
  if (items.length === 0 && window.pinBlockedEvictions === 0) return null;

  return (
    <>
      <BlockOverlay
        blocks={items}
        baseRowId={window.baseRowId}
        rowCount={window.rowCount}
        cellHeightPx={cellHeightPx}
      />
      <EvictionBanner
        pinBlockedEvictions={window.pinBlockedEvictions}
        pinnedRowCount={window.pinnedRowCount}
        freeableBytes={freeableBytes}
      />
    </>
  );
}

BlockOverlayHost.displayName = 'BlockOverlayHost';
