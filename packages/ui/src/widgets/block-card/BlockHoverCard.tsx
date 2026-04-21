/**
 * BlockHoverCard — rich tooltip surfaced when the user hovers a BlockCard
 * header.
 *
 * Scope
 * -----
 * A compact information-dense card inspired by code-editor symbol hover
 * cards (icon + name + badge on top, metric bars in the middle, keyboard
 * shortcut row on the bottom). Purely informational: the real action
 * buttons still live on the header itself. This card only surfaces
 * context the user would otherwise have to expand the block to see
 * (full cwd, shell, byte size, lifecycle timing, rerun lineage).
 *
 * Positioning
 * -----------
 * Portal-rendered to `document.body` so it can escape the BlockList's
 * overflow clip and the BlockCard's rounded-corner mask — the same trick
 * the base Tooltip primitive uses. Anchor coordinates come from the
 * trigger's `getBoundingClientRect()` and are fed into CSS custom
 * properties (`--x` / `--y`) rather than inline positioning so
 * `prefers-reduced-motion` users still get the same layout without the
 * transition flicker.
 *
 * Empty states
 * ------------
 * Every section short-circuits to null when its data is absent (no rerun
 * lineage → "why" row hidden; no exit code yet → exit row hidden). The
 * card never collapses below its minimum height because the header +
 * metric rows + shortcut row always render.
 */

import { memo, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Block, BlockStatus } from '../../entities/block/index.js';
import { useBlockStore } from '../../entities/block/index.js';
import { useSessionsStore } from '../../entities/session/index.js';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { cx } from '../../shared/lib/cx.js';
import { formatShortcutHint } from '../../shared/lib/keymap.js';
import styles from './block-hover-card.module.css';

export interface BlockHoverCardProps {
  /**
   * The block to describe. The caller passes the latest snapshot it has.
   * The card subscribes imperatively on open to grab a fresh copy of
   * `outputChunks` (for the byte/line counters), since the parent
   * BlockCard memo bails out on `block.id` stability and the prop can
   * lag a streaming tail.
   */
  readonly block: Block;
  /** Screen-space anchor point (viewport coords). The card centers horizontally
   *  on `x` and floats above `y`. */
  readonly x: number;
  readonly y: number;
  /** Whether the card should be visible. We always keep the node mounted
   *  (see BlockCard.tsx — hover debounced externally) so fade-out has a
   *  chance to play. */
  readonly open: boolean;
  /** Optional extra class forwarded to the root. */
  readonly className?: string;
}

const STATUS_LABEL: Record<BlockStatus, string> = {
  running: 'RUNNING',
  completed: 'DONE',
  canceled: 'CANCEL',
  error: 'FAIL',
};

const STATUS_TONE: Record<BlockStatus, 'running' | 'success' | 'danger' | 'warning' | 'neutral'> = {
  running: 'running',
  completed: 'success',
  canceled: 'warning',
  error: 'danger',
};

/** Format a millisecond duration with the same cadence as the card header
 *  but without the tabular-numeric lock (we do that in CSS). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/** Short human-readable "time since" — "just now" / "42s ago" / "5m ago" /
 *  "2h ago" / "3d ago". Good enough for a hover card; we never try to be
 *  Precise-with-a-capital-P since the value is re-rendered each hover. */
function formatTimeAgo(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 5_000) return 'just now';
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** Total bytes across the block's chunk list. Cheap — we only sum, never
 *  decode. */
function totalBytes(chunks: readonly Uint8Array[]): number {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  return n;
}

/** Count newlines across the chunk list (same trick BlockBody uses). */
function countLines(chunks: readonly Uint8Array[]): number {
  let newlines = 0;
  let any = false;
  let endsNL = false;
  for (const chunk of chunks) {
    if (chunk.byteLength === 0) continue;
    any = true;
    for (let i = 0; i < chunk.byteLength; i += 1) {
      if (chunk[i] === 0x0a) newlines += 1;
    }
    endsNL = chunk[chunk.byteLength - 1] === 0x0a;
  }
  if (!any) return 0;
  return endsNL ? newlines : newlines + 1;
}

/** Human byte count — "512B" / "1.2KB" / "3MB". Tabular numeric alignment
 *  is applied by the metric value element's font-variant-numeric. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function BlockHoverCardImpl(props: BlockHoverCardProps) {
  const { block: propBlock, x, y, open, className } = props;

  // When the card opens, snap a fresh copy of the block from the store so
  // output chunk counts aren't stale from the parent memo's last render.
  // When closed we fall back to the prop so the node can still render a
  // ghost for the fade-out transition without touching the store.
  const block = useMemo(() => {
    if (!open) return propBlock;
    const fromStore = useBlockStore.getState().entities[propBlock.id];
    return fromStore ?? propBlock;
  }, [open, propBlock]);

  // Rerun lineage: look up predecessor + any successor in the store without
  // firing a subscription per render — the imperative getState call runs
  // once per render (cheap) and the card only re-renders when the parent
  // passes a new block reference / open flag.
  const lineage = useMemo(() => {
    const state = useBlockStore.getState();
    const rerunOf = block.rerunOfId ? state.entities[block.rerunOfId] : null;
    let successor: Block | null = null;
    for (const id of state.order) {
      const b = state.entities[id];
      if (b && b.rerunOfId === block.id) {
        successor = b;
        break;
      }
    }
    return { rerunOf, successor };
  }, [block.id, block.rerunOfId]);

  // Session lookup for shell info — imperative for the same reason.
  const shell = useMemo(() => {
    const state = useSessionsStore.getState();
    const entity = state.entities[block.sessionId];
    return entity?.shell ?? '';
  }, [block.sessionId]);

  const chunks = block.outputChunks;
  const bytes = useMemo(() => totalBytes(chunks), [chunks]);
  const lines = useMemo(() => countLines(chunks), [chunks]);
  const now = Date.now();
  const end = block.completedAt ?? now;
  const durationMs = Math.max(0, end - block.startedAt);

  // Bars: duration caps at 60s visually (longer runs still render full).
  // Size caps at 1MB.
  const durationPct = Math.min(100, (durationMs / 60_000) * 100);
  const sizePct = Math.min(100, (bytes / (1024 * 1024)) * 100);

  // Duration tone: green under 10s, warning 10-30s, danger > 30s. Gives
  // the user a glanceable perf vibe without needing numbers.
  const durationTone = durationMs > 30_000 ? 'danger' : durationMs > 10_000 ? 'warning' : 'success';

  const exitAttr =
    block.exitCode === null ? undefined : block.exitCode === 0 ? '0' : 'nonzero';
  const isError = block.exitCode !== null && block.exitCode !== 0;

  // Short display id ("blk-xxxxxx") — full UUIDs are too long for the
  // top-right badge. We take the last 6 chars which is typically the
  // stable suffix region of a UUIDv4.
  const shortId = useMemo(() => {
    const id = block.id;
    return id.length <= 8 ? id : `blk-${id.slice(-6)}`;
  }, [block.id]);

  const style = {
    ['--x' as string]: `${x}px`,
    ['--y' as string]: `${y}px`,
  } as React.CSSProperties;

  const card = (
    <div
      role="tooltip"
      className={cx(styles.card, className)}
      data-open={open ? 'true' : 'false'}
      data-testid={`block-hover-card-${block.id}`}
      style={style}
    >
      <div className={styles.header}>
        <span className={styles.dot} data-status={block.status} data-exit={exitAttr} aria-hidden />
        <span className={styles.command}>{block.command}</span>
        <span className={styles.blockIndex}>{shortId}</span>
        <span className={styles.statusBadge} data-tone={STATUS_TONE[block.status]}>
          {STATUS_LABEL[block.status]}
        </span>
      </div>

      {(block.cwd || shell) && (
        <div className={styles.stats} aria-label="Session context">
          {block.cwd && <div>cwd: {block.cwd}</div>}
          {shell && <div>shell: {shell}</div>}
        </div>
      )}

      <div className={styles.metrics} aria-label="Block metrics">
        <span className={styles.metricLabel}>DURATION</span>
        <span className={styles.metricBar} aria-hidden>
          <span
            className={styles.metricFill}
            data-tone={durationTone}
            style={{ ['--w' as string]: `${durationPct}%` } as React.CSSProperties}
          />
        </span>
        <span className={styles.metricValue}>{formatDuration(durationMs)}</span>

        <span className={styles.metricLabel}>SIZE</span>
        <span className={styles.metricBar} aria-hidden>
          <span
            className={styles.metricFill}
            style={{ ['--w' as string]: `${sizePct}%` } as React.CSSProperties}
          />
        </span>
        <span className={styles.metricValue}>{formatBytes(bytes)}</span>

        <span className={styles.metricLabel}>LINES</span>
        <span className={styles.metricBar} aria-hidden>
          <span
            className={styles.metricFill}
            style={{ ['--w' as string]: `${Math.min(100, lines * 2)}%` } as React.CSSProperties}
          />
        </span>
        <span className={styles.metricValue}>{lines}</span>
      </div>

      <div className={styles.tags}>
        <span className={styles.tag}>#{String(block.sessionId).slice(0, 6)}</span>
        {block.pinned && <span className={styles.tag}>#pinned</span>}
        {isError && <span className={styles.tag}>#error</span>}
        {block.status === 'running' && <span className={styles.tag}>#running</span>}
      </div>

      {lineage.rerunOf && (
        <div className={styles.why}>
          <span className={styles.whyArrow}>↳</span>
          <span className={styles.whyLabel}>rerun of</span>
          <span className={styles.whyTarget}>{lineage.rerunOf.command}</span>
        </div>
      )}
      {lineage.successor && (
        <div className={styles.why}>
          <span className={styles.whyArrow}>↪</span>
          <span className={styles.whyLabel}>rerun'd as</span>
          <span className={styles.whyTarget}>{lineage.successor.command}</span>
        </div>
      )}
      {(lineage.rerunOf || lineage.successor) && (
        <div className={styles.similar}>
          <span className={styles.similarValue}>{formatShortcutHint('mod+d')}</span> opens compare panel
        </div>
      )}

      <div className={styles.lifecycle}>
        <strong>started</strong>
        {formatTimeAgo(block.startedAt, now)}
        {block.completedAt !== null && (
          <>
            {' · '}
            <strong>done</strong>
            {formatDuration(durationMs)}
          </>
        )}
        {block.exitCode !== null && (
          <>
            {' · '}
            <strong>exit</strong>
            {block.exitCode}
          </>
        )}
      </div>

      <div className={styles.divider} aria-hidden />

      <div className={styles.actions} aria-label="Keyboard shortcuts">
        <span className={styles.action}>
          <Kbd>⏎</Kbd>
          <span className={styles.actionLabel}>open</span>
        </span>
        <span className={styles.action}>
          <Kbd>{formatShortcutHint('mod+c')}</Kbd>
          <span className={styles.actionLabel}>copy output</span>
        </span>
        <span className={styles.action}>
          <Kbd>{formatShortcutHint('mod+r')}</Kbd>
          <span className={styles.actionLabel}>rerun</span>
        </span>
        <span className={styles.action}>
          <Kbd>{formatShortcutHint('mod+e')}</Kbd>
          <span className={styles.actionLabel}>export</span>
        </span>
        <span
          className={styles.action}
          data-disabled={lineage.rerunOf || lineage.successor ? 'false' : 'true'}
        >
          <Kbd>{formatShortcutHint('mod+d')}</Kbd>
          <span className={styles.actionLabel}>diff</span>
        </span>
      </div>
    </div>
  );

  // Portal guard for jsdom/SSR: when `document` is unavailable we return the
  // card inline — still semantically valid (role="tooltip") and rarely hit
  // outside tests. In normal browser usage we portal so we escape clips.
  if (typeof document === 'undefined') return card;
  return createPortal(card, document.body);
}

/**
 * Memo on shallow prop identity. The parent passes a stable `block` ref
 * (it comes from a store selector with `useShallow`) plus an open flag,
 * so re-renders are gated on actual visibility transitions.
 */
export const BlockHoverCard = memo(BlockHoverCardImpl, (prev, next) => {
  return (
    prev.block === next.block &&
    prev.open === next.open &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.className === next.className
  );
});

BlockHoverCard.displayName = 'BlockHoverCard';
