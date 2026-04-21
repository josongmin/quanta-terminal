/**
 * TabHoverPreview — portal-rendered preview card for an inactive session tab.
 *
 * Scope
 * -----
 * Surfaced after a 600ms dwell over an inactive tab in the tab strip. Shows
 * the tab's title, cwd, shell, health chip, and a miniature rendering of the
 * last ~6 lines of that session's latest block output. Purely informational —
 * click-through still activates the tab immediately and cancels any pending
 * preview.
 *
 * Portal
 * ------
 * Same strategy as `BlockHoverCard`: render into `document.body` so the card
 * escapes the tab row's `overflow-x: auto` clip and any stacking contexts
 * established by the terminal page chrome. Position is `fixed`, driven by
 * `--x` / `--y` custom properties computed from the trigger's
 * `getBoundingClientRect()`. We anchor to the tab's bottom-right and shift
 * left when the card would overflow the viewport.
 *
 * Data source
 * -----------
 * The preview subscribes imperatively on hover open — it reads the latest
 * block for the hovered session directly from `useBlockStore.getState()`,
 * picks the last few lines of its `outputChunks`, and snapshots them at
 * mount time. We don't live-stream: a hover preview that jitters while
 * scrolling bytes in is distracting. If the user keeps hovering and new
 * output arrives, they'll see it the next time they hover.
 *
 * Accessibility
 * -------------
 * The card is decorative — the tab itself already exposes the accessible
 * name via `aria-label`. We mark the card `aria-hidden="true"` so screen
 * readers ignore it. `prefers-reduced-motion` snaps the card open with no
 * fade transition (the CSS handles this).
 */

import { memo, useMemo } from 'react';
import { createPortal } from 'react-dom';

import { useBlockStore, type Block } from '../../entities/block/index.js';
import type { SessionHealth } from '../../entities/session/model.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { cx } from '../../shared/lib/cx.js';
import { t } from '../../shared/i18n/index.js';
import styles from './tab-hover-preview.module.css';

/** Max chars per preview line; anything longer is ellipsized. Roughly matches
 *  the 360px card width at the mono font. */
const PREVIEW_LINE_MAX = 60;
/** How many trailing output lines to show. */
const PREVIEW_LINE_COUNT = 6;
/** Gap between the tab's bottom edge and the card. */
const CARD_GAP_PX = 6;
/** Safety margin when clamping to the viewport. */
const VIEWPORT_MARGIN_PX = 8;

/** Shared TextDecoder — one instance is plenty since each hover decodes at
 *  most a handful of kilobytes. */
const DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

export interface TabHoverPreviewProps {
  /** The hovered session id. We resolve cwd / shell / health via the store. */
  readonly sessionId: SessionId;
  /** Human shell path (or basename) — caller already has it on the tab view. */
  readonly shell: string;
  /** Absolute cwd string. */
  readonly cwd: string;
  /** Health state (drives the chip color/text). */
  readonly health: SessionHealth;
  /** Display title for the card header (shell basename, short cwd, etc.). */
  readonly title: string;
  /** Viewport coordinate of the trigger's right edge (px). */
  readonly anchorRight: number;
  /** Viewport coordinate of the trigger's bottom edge (px). */
  readonly anchorBottom: number;
  /** Whether the card is visible. Always-mounted for fade transitions. */
  readonly open: boolean;
}

const HEALTH_KEY: Record<SessionHealth, string> = {
  ready: 'sessionTabs.preview.healthReady',
  booting: 'sessionTabs.preview.healthBooting',
  exited: 'sessionTabs.preview.healthExited',
  error: 'sessionTabs.preview.healthError',
};

/**
 * Middle-ellipsize a path so both the prefix and tail remain visible.
 * Used for the cwd row where the most interesting part is usually the tail
 * directory name but the caller also wants to know which branch of the tree.
 */
function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = max - 1; // reserve 1 for the ellipsis char
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${value.slice(0, head)}\u2026${value.slice(value.length - tail)}`;
}

/** Clamp a raw line to PREVIEW_LINE_MAX, preserving the tail when it's the
 *  part with the meaningful content (e.g. the last segment of a long file
 *  path). We keep the leading portion because terminal output is usually
 *  read left-to-right; this is a simple tail-ellipsis, not middle. */
function truncateTail(value: string, max: number = PREVIEW_LINE_MAX): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '\u2026';
}

/**
 * Decode + strip ANSI escapes down to plain text, then return the last N
 * non-empty lines.  We only decode the tail of the buffer to keep large
 * output cheap: a 10MB log would be wasteful to concat on hover.
 */
function extractTailLines(chunks: readonly Uint8Array[], n: number): string[] {
  if (chunks.length === 0) return [];
  // Take only the trailing ~8KB of bytes — more than enough for 6 lines.
  const TAIL_BYTES = 8 * 1024;
  let remaining = TAIL_BYTES;
  const tailChunks: Uint8Array[] = [];
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const chunk = chunks[i];
    if (!chunk) continue;
    if (chunk.byteLength <= remaining) {
      tailChunks.unshift(chunk);
      remaining -= chunk.byteLength;
    } else {
      tailChunks.unshift(chunk.subarray(chunk.byteLength - remaining));
      remaining = 0;
    }
  }
  let totalLen = 0;
  for (const c of tailChunks) totalLen += c.byteLength;
  const buf = new Uint8Array(totalLen);
  let off = 0;
  for (const c of tailChunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = DECODER.decode(buf);
  const stripped = stripAnsi(text).replace(/\r\n?/g, '\n');
  const all = stripped.split('\n');
  // Skip trailing empty line (the usual output ends with a newline).
  while (all.length > 0 && all[all.length - 1] === '') all.pop();
  return all.slice(-n);
}

/**
 * Minimal ANSI escape stripper. We only need enough to not show tofu in the
 * preview; the full AnsiParser is overkill here (and pulling it in would
 * require a parser instance per render). Covers CSI, OSC, and simple C1/SS3
 * patterns, which is what zsh, bash, and common CLIs emit.
 */
function stripAnsi(input: string): string {
  // CSI: ESC [ ... final byte in 0x40-0x7E
  const csi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
  // OSC: ESC ] ... BEL or ESC \
  const osc = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
  // Lone ESC/SS2/SS3 + one byte
  const other = /\x1B[@-Z\\-_]/g;
  return input.replace(csi, '').replace(osc, '').replace(other, '');
}

/**
 * Pull the most-recent block for this session. Scan the store's `order` from
 * the tail — blocks are appended, so the last id that matches the session is
 * the latest one. Snapshot-style read, no subscription.
 */
function findLatestBlockForSession(sessionId: SessionId): Block | null {
  const state = useBlockStore.getState();
  for (let i = state.order.length - 1; i >= 0; i -= 1) {
    const id = state.order[i];
    if (!id) continue;
    const b = state.entities[id];
    if (b && b.sessionId === sessionId) return b;
  }
  return null;
}

function TabHoverPreviewImpl(props: TabHoverPreviewProps) {
  const { sessionId, shell, cwd, health, title, anchorRight, anchorBottom, open } = props;

  // Snapshot on open: pull the latest block + its tail lines once when the
  // card becomes visible. `open` flipping to false doesn't re-read — the
  // old snapshot survives the fade-out.
  const lines = useMemo(() => {
    if (!open) return [];
    const latest = findLatestBlockForSession(sessionId);
    if (!latest) return [];
    return extractTailLines(latest.outputChunks, PREVIEW_LINE_COUNT).map((l) =>
      truncateTail(l, PREVIEW_LINE_MAX),
    );
  }, [open, sessionId]);

  // Viewport clamp: prefer right-aligned to the trigger. If the card would
  // overrun the right edge we shift it left so it stays inside the viewport.
  // Horizontal positioning is in screen space (position: fixed). We assume
  // the card is 360px wide (matches the CSS max-width / width).
  const CARD_WIDTH = 360;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : anchorRight;
  let left = anchorRight - CARD_WIDTH;
  if (left + CARD_WIDTH + VIEWPORT_MARGIN_PX > viewportWidth) {
    left = viewportWidth - CARD_WIDTH - VIEWPORT_MARGIN_PX;
  }
  if (left < VIEWPORT_MARGIN_PX) left = VIEWPORT_MARGIN_PX;
  const top = anchorBottom + CARD_GAP_PX;

  const style = {
    ['--x' as string]: `${left}px`,
    ['--y' as string]: `${top}px`,
  } as React.CSSProperties;

  const displayCwd = truncateMiddle(cwd || '', 48);
  const displayShell = basename(shell) || shell || '';
  const healthLabel = t(HEALTH_KEY[health] as 'sessionTabs.preview.healthReady');

  const card = (
    <div
      aria-hidden="true"
      className={cx(styles.card)}
      data-open={open ? 'true' : 'false'}
      data-testid={`session-tab-preview-${sessionId}`}
      style={style}
    >
      <div className={styles.header}>
        <span className={styles.title}>{title || displayShell || 'session'}</span>
        <span
          className={cx(
            styles.healthChip,
            health === 'ready' && styles.healthReady,
            health === 'booting' && styles.healthBooting,
            health === 'exited' && styles.healthExited,
            health === 'error' && styles.healthError,
          )}
          data-health={health}
        >
          {healthLabel}
        </span>
      </div>

      {displayCwd && (
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>{t('sessionTabs.preview.cwdLabel')}</span>
          <span className={styles.metaValue}>{displayCwd}</span>
        </div>
      )}
      {displayShell && (
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>{t('sessionTabs.preview.shellLabel')}</span>
          <span className={cx(styles.metaValue, styles.metaValueSubtle)}>{displayShell}</span>
        </div>
      )}

      <div className={styles.preview} data-testid={`session-tab-preview-body-${sessionId}`}>
        {lines.length === 0 ? (
          <span className={styles.previewEmpty}>{t('sessionTabs.preview.noOutput')}</span>
        ) : (
          lines.map((line, i) => (
            <span key={i} className={styles.previewLine}>
              {line || '\u00A0'}
            </span>
          ))
        )}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return card;
  return createPortal(card, document.body);
}

function basename(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export const TabHoverPreview = memo(TabHoverPreviewImpl, (prev, next) => {
  return (
    prev.sessionId === next.sessionId &&
    prev.open === next.open &&
    prev.anchorRight === next.anchorRight &&
    prev.anchorBottom === next.anchorBottom &&
    prev.shell === next.shell &&
    prev.cwd === next.cwd &&
    prev.health === next.health &&
    prev.title === next.title
  );
});

TabHoverPreview.displayName = 'TabHoverPreview';
