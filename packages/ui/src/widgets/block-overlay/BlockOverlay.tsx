/**
 * Plan 0005 P1-C — BlockOverlay.
 *
 * Absolute-positioned chrome that paints command blocks as translucent
 * cards on top of the always-on grid canvas. The overlay does NOT render
 * block body glyphs; the grid renderer owns every cell. All the overlay
 * does is hang a header (status dot, command text, duration, exit code,
 * cwd badge) over the row range the block occupies.
 *
 * Inputs
 * ------
 *   - `blocks`: an array of block metadata with a non-null `rowRange`.
 *     Blocks without a row range are invisible to the overlay — legacy
 *     composer-created blocks fall into this bucket and continue rendering
 *     via `BlockList` on their legacy path.
 *   - `baseRowId` + `rowCount`: the scrollback ring's current projection.
 *     `baseRowId` is the id of the row at index 0 in the ring; `rowCount`
 *     is the count of rows currently held. Together they tell the overlay
 *     which rowIds are visible so a card whose `startRow` has been evicted
 *     renders as `null`.
 *   - `cellHeightPx` / `cellWidthPx`: cell metrics from the grid renderer.
 *   - `cellToScreen`: forward-map from (row, col) to a pixel rect. When
 *     omitted, a fallback geometry uses `cellHeightPx` scaled by the
 *     row's offset into the visible scrollback.
 *
 * Output: zero glyphs, one `<article>` per visible block. The article's
 * top/height are derived from the row range; the card flows INSIDE the
 * absolute box and does not exceed it vertically (overflow clipped).
 *
 * Z-index
 * -------
 * The overlay sits above the canvas paint layer but BELOW popovers
 * (command palette, settings). This is enforced by the module.css which
 * sets `z-index: 10` on the overlay root — popovers use 100+.
 *
 * Hit-testing
 * -----------
 * The overlay root has `pointer-events: none` so clicks pass through to
 * the canvas by default. Individual cards use `pointer-events: auto` so
 * chrome buttons intercept as expected. Copy/paste on the grid still
 * works outside card regions; an `Alt`-chord pass-through is NOT
 * implemented in this patch (deferred to P1-C polish).
 */

import { memo, useMemo, type CSSProperties, type JSX } from 'react';
import type { BlockRowRange, BlockConfidence, BlockStatus } from '../../entities/block/index.js';
import { cx } from '../../shared/lib/cx.js';
import styles from './block-overlay.module.css';

/**
 * Slim view of a block for overlay rendering. Matches the read shape the
 * overlay needs; independent from the store's `Block` to keep this widget
 * testable in isolation (tests pass plain fixtures, no store required).
 */
export interface BlockOverlayItem {
  readonly id: string;
  readonly command: string;
  readonly status: BlockStatus;
  readonly exitCode: number | null;
  readonly cwd: string;
  readonly rowRange: BlockRowRange;
  readonly confidence: BlockConfidence | null;
  /** Duration in ms. When `null` the overlay falls back to `completedAt
   *  - startedAt` (computed by the caller) or omits the field on a
   *  still-running block. */
  readonly durationMs: number | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
}

export interface BlockOverlayProps {
  readonly blocks: readonly BlockOverlayItem[];
  /** Current `baseRowId` of the emulator scrollback ring. */
  readonly baseRowId: number;
  /** Count of rows currently held in the ring (live + evicted counts are
   *  surfaced separately — the overlay only cares about currently-present
   *  rows for position calculation). */
  readonly rowCount: number;
  /** Pixel height of one scrollback cell. */
  readonly cellHeightPx: number;
  /** Optional: pixel offset of the top of the visible scrollback within
   *  the overlay's container. Defaults to 0 — set by the caller to match
   *  the grid's internal padding / header. */
  readonly topOffsetPx?: number;
  /** Optional: test override for the CSS class applied to the root. */
  readonly className?: string;
  /** Optional: inline styles merged onto the root (test overrides). */
  readonly style?: CSSProperties;
  /** Optional: the maximum pixel height the overlay may paint into. When
   *  provided, cards whose bottom edge would exceed this get clipped to
   *  the boundary (height floor 1 cell so the header always shows). */
  readonly maxHeightPx?: number;
}

/**
 * Format a ms duration into a short human string. Mirrors the style of
 * the legacy BlockCard's duration pill (e.g. `12ms`, `1.2s`, `1m 02s`).
 */
function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds - minutes * 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

/**
 * Format a cwd path into a short badge label (`~/src/quanta` → `quanta`
 * when the path is long enough to overflow 16ch). Kept naive on purpose:
 * the overlay is a presentation-only widget; the authoritative cwd lives
 * on the block entity.
 */
function formatCwd(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return cwd;
  const tail = parts[parts.length - 1];
  return tail ?? cwd;
}

/**
 * Compute the { top, height } rect for a row range.
 *
 * Coordinates: `startRow` is a rowId (baseRowId + index). The top edge is
 * `(startRow - baseRowId) * cellHeightPx + topOffsetPx`. Height is
 * `(endRowExclusive - startRow) * cellHeightPx` or, for an open range
 * (endRowExclusive === null), `(rowCount - (startRow - baseRowId)) *
 * cellHeightPx` — i.e. the card stretches to the current bottom of the
 * ring and grows with each new row.
 *
 * Returns `null` when the row range is outside the visible ring (the
 * block was evicted). The overlay renders no card for such blocks.
 */
function projectRowRange(
  range: BlockRowRange,
  baseRowId: number,
  rowCount: number,
  cellHeightPx: number,
  topOffsetPx: number,
): { top: number; height: number } | null {
  const startIndex = range.startRow - baseRowId;
  if (startIndex < 0) return null; // Evicted.
  if (startIndex > rowCount) return null; // Past the live ring tail.
  const endIndex =
    range.endRowExclusive !== null
      ? range.endRowExclusive - baseRowId
      : rowCount;
  const height = Math.max(1, endIndex - startIndex) * cellHeightPx;
  const top = startIndex * cellHeightPx + topOffsetPx;
  return { top, height };
}

/**
 * Single block card — memoized so the overlay re-renders on scroll
 * without ripping every card's chrome. Memoization is keyed on the
 * stable fields that determine visual output.
 */
const BlockOverlayCard = memo(function BlockOverlayCard(props: {
  readonly item: BlockOverlayItem;
  readonly top: number;
  readonly height: number;
  readonly maxHeightPx: number | undefined;
}): JSX.Element {
  const { item, top, height, maxHeightPx } = props;
  const clampedHeight =
    maxHeightPx !== undefined && top + height > maxHeightPx
      ? Math.max(16, maxHeightPx - top)
      : height;
  const confidence: BlockConfidence = item.confidence ?? 'synthetic';
  const isComplete =
    item.status === 'completed' ||
    item.status === 'canceled' ||
    item.status === 'error';
  const liveDuration =
    item.durationMs !== null
      ? item.durationMs
      : isComplete && item.completedAt !== null
        ? item.completedAt - item.startedAt
        : null;
  const durationLabel = liveDuration !== null ? formatDuration(liveDuration) : '';
  const showExitCode = isComplete && item.exitCode !== null;
  const cwdLabel = formatCwd(item.cwd);

  return (
    <article
      className={styles.card}
      data-testid="block-overlay-card"
      data-block-id={item.id}
      data-status={item.status}
      data-confidence={confidence}
      aria-label={`Block ${item.command || 'running'}`}
      style={{ top, height: clampedHeight }}
    >
      <header className={styles.header}>
        <span aria-hidden className={styles.statusDot} />
        <span className={styles.command} data-testid="block-overlay-command">
          {item.command}
        </span>
        {durationLabel ? (
          <span className={styles.duration} data-testid="block-overlay-duration">
            {durationLabel}
          </span>
        ) : null}
        {showExitCode ? (
          <span
            className={styles.exitCode}
            data-testid="block-overlay-exit-code"
            data-ok={item.exitCode === 0 ? 'true' : 'false'}
          >
            {item.exitCode}
          </span>
        ) : null}
        {cwdLabel ? (
          <span className={styles.cwd} data-testid="block-overlay-cwd">
            {cwdLabel}
          </span>
        ) : null}
      </header>
    </article>
  );
});

/**
 * Plan 0005 P1-C — the overlay container.
 *
 * Renders one `<article>` per block whose row range projects into the
 * current scrollback window. Evicted blocks (`startRow < baseRowId`) are
 * skipped entirely; the caller is responsible for unmounting them from
 * the list when desired.
 */
export function BlockOverlay(props: BlockOverlayProps): JSX.Element {
  const {
    blocks,
    baseRowId,
    rowCount,
    cellHeightPx,
    topOffsetPx = 0,
    className,
    style,
    maxHeightPx,
  } = props;

  // Precompute the projected cards once per render. Cards with null
  // projection (evicted) are filtered here so the DOM exactly matches the
  // visible set — simplifies E2E snapshots.
  const projected = useMemo(() => {
    const out: Array<{
      item: BlockOverlayItem;
      top: number;
      height: number;
    }> = [];
    for (const b of blocks) {
      const rect = projectRowRange(
        b.rowRange,
        baseRowId,
        rowCount,
        cellHeightPx,
        topOffsetPx,
      );
      if (rect === null) continue;
      out.push({ item: b, top: rect.top, height: rect.height });
    }
    return out;
  }, [blocks, baseRowId, rowCount, cellHeightPx, topOffsetPx]);

  return (
    <div
      className={cx(styles.root, className)}
      data-testid="block-overlay"
      data-block-count={projected.length}
      style={style}
    >
      {projected.map((p) => (
        <BlockOverlayCard
          key={p.item.id}
          item={p.item}
          top={p.top}
          height={p.height}
          maxHeightPx={maxHeightPx}
        />
      ))}
    </div>
  );
}

BlockOverlay.displayName = 'BlockOverlay';

// Exposed for unit tests — the pure projection function is a clean seam
// for "given these inputs, output these rects" without driving React.
export { projectRowRange, formatDuration, formatCwd };
