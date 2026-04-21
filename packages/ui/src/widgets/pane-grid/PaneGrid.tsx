/**
 * PaneGrid — recursive split container for multi-pane layouts.
 *
 * Reads the pane tree from `entities/pane` (`usePaneStore`) and renders it
 * as a nested flex layout:
 *
 *   - Leaf  → a single pane slot. The slot hosts the app surface (BlockList +
 *             alt-screen surfaces) scoped to the pane's session id. The
 *             focused leaf gets `data-active="true"` so the theme can draw a
 *             subtle border.
 *   - Split → a flex row/column with two children. A draggable resizer sits
 *             between them; dragging updates the split's `ratio` via
 *             `usePaneStore.setRatio`, clamped to [0.1, 0.9] so neither pane
 *             can collapse to zero.
 *
 * The widget is intentionally unaware of the session lifecycle. Splitting and
 * closing panes goes through `features/pane-tabs` (splitActivePane /
 * closeActivePane), which own PTY spawn/teardown. PaneGrid only observes the
 * tree.
 *
 * When the tree is empty (`root === null`) the component renders the
 * fallback provided via `renderFallback` — e.g. the legacy single-session
 * `BlockList` + loading chrome — so the first-boot path stays unchanged.
 */

import {
  useCallback,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import {
  collectLeaves,
  usePaneStore,
  type PaneNode,
  type PaneSplit,
} from '../../entities/pane/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { cx } from '../../shared/lib/cx.js';
import { t } from '../../shared/i18n/index.js';
import { Badge } from '../../shared/ui/badge/index.js';
import { formatShortcutHint } from '../../shared/lib/keymap.js';

import styles from './pane-grid.module.css';

/** The shortcut that toggles pane zoom. Mirrored here for the badge tooltip
 * text so both signal the same chord without a cross-import to TerminalPage. */
export const PANE_ZOOM_SHORTCUT = 'mod+shift+enter';

export interface PaneGridProps {
  /**
   * Renders the contents of a single pane leaf. Receives the session id and
   * whether it is the focused leaf so the pane can mount session-scoped
   * surfaces (BlockList, TuiSurface, etc.).
   */
  readonly renderPane: (sessionId: SessionId, isFocused: boolean) => ReactNode;
  /**
   * Optional fallback rendered when the pane tree is empty. Keeps the
   * pre-split single-session flow unchanged — the first session bootstrap
   * happens before `setRoot` is called.
   */
  readonly renderFallback?: () => ReactNode;
  /**
   * Called when a leaf is focused by mouse/keyboard. The widget itself does
   * NOT call `switchSession` (to keep the feature layering clean); the
   * caller plumbs this into the session lifecycle.
   */
  readonly onPaneFocus?: (sessionId: SessionId) => void;
}

export function PaneGrid({ renderPane, renderFallback, onPaneFocus }: PaneGridProps) {
  const root = usePaneStore((s) => s.root);
  const focusPath = usePaneStore((s) => s.focusPath);
  const zoomedPaneId = usePaneStore((s) => s.zoomedPaneId);

  // Resolve the path of the zoomed leaf once per render, memoized so the tree
  // walk only re-runs when `root` or `zoomedPaneId` actually changes. When
  // non-null, the tree walk below flags every non-ancestor subtree with
  // `hiddenForZoom`, collapsing them via CSS `display: none` while leaving
  // the React subtree mounted (so session state is preserved).
  const zoomedPath = useMemo(
    () =>
      root && zoomedPaneId
        ? collectLeaves(root).find((l) => l.sessionId === zoomedPaneId)?.path ?? null
        : null,
    [root, zoomedPaneId],
  );

  if (!root) {
    return <div className={styles.root}>{renderFallback ? renderFallback() : null}</div>;
  }

  return (
    <div className={styles.root} data-zoomed={zoomedPath ? 'true' : 'false'}>
      <PaneNodeView
        node={root}
        path={[]}
        focusPath={focusPath}
        zoomedPath={zoomedPath}
        renderPane={renderPane}
        onPaneFocus={onPaneFocus}
      />
    </div>
  );
}

PaneGrid.displayName = 'PaneGrid';

interface NodeViewProps {
  readonly node: PaneNode;
  readonly path: readonly number[];
  readonly focusPath: readonly number[];
  /** Path of the currently zoomed leaf, or `null` when nothing is zoomed. */
  readonly zoomedPath: readonly number[] | null;
  readonly renderPane: (sessionId: SessionId, isFocused: boolean) => ReactNode;
  readonly onPaneFocus: ((sessionId: SessionId) => void) | undefined;
}

function PaneNodeView({
  node,
  path,
  focusPath,
  zoomedPath,
  renderPane,
  onPaneFocus,
}: NodeViewProps) {
  if (node.kind === 'leaf') {
    const isFocused = pathEq(path, focusPath);
    const isZoomed = zoomedPath !== null && pathEq(path, zoomedPath);
    const handleFocusClick = () => {
      if (!isFocused && onPaneFocus) onPaneFocus(node.sessionId);
    };
    return (
      <div
        className={styles.pane}
        data-active={isFocused ? 'true' : 'false'}
        data-zoomed={isZoomed ? 'true' : 'false'}
        data-session-id={String(node.sessionId)}
        data-testid={`pane-leaf-${node.sessionId}`}
        onMouseDownCapture={handleFocusClick}
        role="group"
        aria-label={t('paneLayout.paneLabel', { id: String(node.sessionId) })}
      >
        {isZoomed ? (
          <div className={styles.zoomBadge} data-testid="pane-zoom-badge">
            <Badge
              label={t('paneLayout.zoomBadge')}
              tone="accent"
              srDescription={t('paneLayout.zoomBadgeTooltip', {
                shortcut: formatShortcutHint(PANE_ZOOM_SHORTCUT),
              })}
              title={t('paneLayout.zoomBadgeTooltip', {
                shortcut: formatShortcutHint(PANE_ZOOM_SHORTCUT),
              })}
            />
          </div>
        ) : null}
        <div className={styles.paneBody}>{renderPane(node.sessionId, isFocused)}</div>
      </div>
    );
  }
  return (
    <SplitView
      split={node}
      path={path}
      focusPath={focusPath}
      zoomedPath={zoomedPath}
      renderPane={renderPane}
      onPaneFocus={onPaneFocus}
    />
  );
}

interface SplitViewProps {
  readonly split: PaneSplit;
  readonly path: readonly number[];
  readonly focusPath: readonly number[];
  readonly zoomedPath: readonly number[] | null;
  readonly renderPane: (sessionId: SessionId, isFocused: boolean) => ReactNode;
  readonly onPaneFocus: ((sessionId: SessionId) => void) | undefined;
}

function SplitView({
  split,
  path,
  focusPath,
  zoomedPath,
  renderPane,
  onPaneFocus,
}: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const setRatio = usePaneStore((s) => s.setRatio);

  const startDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = true;
      const target = e.currentTarget;
      target.dataset['dragging'] = 'true';
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* older browsers or detached nodes — safe to ignore */
      }
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = computeRatioFromEvent(split.dir, rect, e.clientX, e.clientY);
      setRatio(path, ratio);
    },
    [split.dir, setRatio, path],
  );

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    const target = e.currentTarget;
    target.dataset['dragging'] = 'false';
    try {
      target.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
  }, []);

  const leftFlex = clampRatio(split.ratio);
  const rightFlex = 1 - leftFlex;

  // When zoom is active, one child wrapper on the path to the zoomed leaf
  // must remain visible (its descendants render normally) and the other
  // must hide entirely. `zoomedPath` indexes into the global tree — at this
  // node's depth, the relevant step is `zoomedPath[path.length]`.
  const leftHiddenForZoom =
    zoomedPath !== null && zoomedPath.length > path.length && zoomedPath[path.length] !== 0;
  const rightHiddenForZoom =
    zoomedPath !== null && zoomedPath.length > path.length && zoomedPath[path.length] !== 1;
  const resizerHiddenForZoom = zoomedPath !== null;

  // Keyboard-accessible resize: arrow keys nudge the ratio by 2 %.
  const onResizerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (split.dir === 'horizontal') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setRatio(path, split.ratio - step);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setRatio(path, split.ratio + step);
          return;
        }
      } else {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setRatio(path, split.ratio - step);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setRatio(path, split.ratio + step);
          return;
        }
      }
    },
    [split.dir, split.ratio, setRatio, path],
  );

  return (
    <div
      ref={containerRef}
      className={cx(
        styles.split,
        split.dir === 'horizontal' ? styles.horizontal : styles.vertical,
      )}
      data-testid={`pane-split-${pathKey(path)}`}
      data-direction={split.dir}
    >
      <div
        style={flexStyle(split.dir, leftFlex)}
        className={cx(leftHiddenForZoom ? styles.hiddenForZoom : undefined)}
        data-testid={`pane-wrap-${pathKey([...path, 0])}`}
      >
        <PaneNodeView
          node={split.left}
          path={[...path, 0]}
          focusPath={focusPath}
          zoomedPath={zoomedPath}
          renderPane={renderPane}
          onPaneFocus={onPaneFocus}
        />
      </div>
      <div
        className={cx(
          styles.resizer,
          split.dir === 'horizontal' ? styles.horizontal : styles.vertical,
          resizerHiddenForZoom ? styles.hiddenForZoom : undefined,
        )}
        role="separator"
        tabIndex={0}
        aria-orientation={split.dir === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-label={t('paneLayout.resizerLabel')}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(leftFlex * 100)}
        data-testid={`pane-resizer-${pathKey(path)}`}
        onPointerDown={startDrag}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onResizerKeyDown}
      />
      <div
        style={flexStyle(split.dir, rightFlex)}
        className={cx(rightHiddenForZoom ? styles.hiddenForZoom : undefined)}
        data-testid={`pane-wrap-${pathKey([...path, 1])}`}
      >
        <PaneNodeView
          node={split.right}
          path={[...path, 1]}
          focusPath={focusPath}
          zoomedPath={zoomedPath}
          renderPane={renderPane}
          onPaneFocus={onPaneFocus}
        />
      </div>
    </div>
  );
}

function flexStyle(dir: 'horizontal' | 'vertical', flex: number): CSSProperties {
  // `flex-basis: 0` + the ratio as `flex-grow` keeps the allocation honest
  // regardless of the child's intrinsic size. Both axes use the same formula;
  // only the direction of the PARENT container changes.
  return {
    flex: `${flex} ${flex} 0`,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: dir === 'horizontal' ? 'row' : 'column',
    overflow: 'hidden',
  };
}

function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(0.9, Math.max(0.1, r));
}

/** Derive a new ratio from a pointer event, given the container rect. */
export function computeRatioFromEvent(
  dir: 'horizontal' | 'vertical',
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): number {
  if (dir === 'horizontal') {
    if (rect.width <= 0) return 0.5;
    return (clientX - rect.left) / rect.width;
  }
  if (rect.height <= 0) return 0.5;
  return (clientY - rect.top) / rect.height;
}

function pathEq(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function pathKey(path: readonly number[]): string {
  return path.length === 0 ? 'root' : path.join('-');
}
