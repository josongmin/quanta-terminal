/**
 * SideBySideHarness — dev-mode overlay that renders the canvas renderer
 * alongside a reference memory-mirror on a shared event stream.
 *
 * EPIC-I note (RFC 0001 §19 — xterm removal): historically the right
 * pane mounted the legacy `TerminalShell` (xterm.js) so divergences
 * between the two renderers surfaced as `CellDiff` / `CursorDiff` /
 * `ModeDiff` entries. With xterm removed, the harness retains its
 * diff-recording infrastructure but now feeds BOTH panes from the same
 * `GridMirror`, so the default behaviour is "parity by construction":
 * the diff path still runs and is useful when a caller injects a
 * `xtermSnapshot` stub to simulate a divergence (regression detection).
 *
 * Dev-only: the module is tree-shaken from production builds via
 * `import.meta.env.DEV` guards at the call site (TerminalPage only
 * instantiates when the dev flag is on).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import { MirrorSource } from '../../shared/ui/cell-renderer/index.js';
// Cross-slice: the side-by-side harness needs to render the renderer in
// place; by contract it is ALLOWED to reach into widget layer because
// the entire point of the feature is to compare widgets. ADR 0014
// layering is preserved by keeping this strictly dev-only
// (tree-shaken in prod).
// FIXME(fsd-layer-skip): dev-only side-by-side harness renders widget-layer terminals
import { TerminalCanvas } from '../../widgets/terminal-canvas/index.js';
// FIXME(fsd-layer-skip): compat harness type-borrows session ConnectedSession handle
import type { ConnectedSession } from '../session/index.js';
import { t } from '../../shared/i18n/index.js';
import { createLogger } from '../../shared/lib/logger.js';
import { diffFrames, type Diff, type FrameSnapshot } from './side-by-side-diff.js';
import { SideBySideRecorder, type DiffSnapshot } from './side-by-side-recorder.js';
import styles from './side-by-side.module.css';

const log = createLogger('compat.side-by-side');

export interface SideBySideHarnessProps {
  readonly mirror: GridMirror;
  readonly mirrorSource: MirrorSource;
  readonly session: ConnectedSession | null;
  readonly diffIntervalFrames?: number;
  /** Fires when the user clicks the export button; payload is the ring JSON. */
  readonly onExportDiff?: (json: string) => void;
  /** Hook for tests — fires on every scheduled diff. */
  readonly onDiff?: (snapshot: DiffSnapshot) => void;
  /**
   * Snapshot builder for the reference side. When omitted, the harness
   * treats the reference as "parity with canvas"; tests inject a stub
   * to exercise the diff path deterministically.
   *
   * The prop name is retained for backwards compatibility with existing
   * callers from before EPIC-I. See `historical-xterm-reference:` below.
   */
  // historical-xterm-reference: name preserved for call-site compatibility
  readonly xtermSnapshot?: () => FrameSnapshot | null;
}

export function SideBySideHarness(props: SideBySideHarnessProps): JSX.Element {
  // `session` is accepted for API stability with pre-EPIC-I callers; the
  // reference pane no longer opens a second PTY so the handle is unused.
  const {
    mirror,
    mirrorSource,
    session: _session,
    diffIntervalFrames = 10,
    onExportDiff,
    onDiff,
    xtermSnapshot,
  } = props;

  const recorderRef = useRef<SideBySideRecorder | null>(null);
  if (recorderRef.current === null) recorderRef.current = new SideBySideRecorder();

  // Both panes share the same mirrorSource — any divergence must come
  // from an injected snapshot builder (typically a test that forces a
  // regression to verify the diff path still fires). A fanout
  // subscription lets the harness snapshot both sides at the same
  // frame without disrupting the existing subscribers.
  const canvasSource = mirrorSource;

  const [summary, setSummary] = useState<{ cells: number; frames: number }>({
    cells: 0,
    frames: 0,
  });

  const snapshotCanvas = useCallback((): FrameSnapshot => {
    const { rows, cols } = mirror.getDimensions();
    const cells: { grapheme: string; cols: number; sgr: string; hyperlink_id: number }[][] = [];
    for (let r = 0; r < rows; r += 1) {
      const row = mirror.getRow(r);
      const rowCells: {
        grapheme: string;
        cols: number;
        sgr: string;
        hyperlink_id: number;
      }[] = [];
      if (row) {
        for (let c = 0; c < cols; c += 1) {
          const cell = row.cells[c];
          if (cell) {
            rowCells.push({
              grapheme: cell.grapheme,
              cols: cell.cols,
              sgr: cell.sgr,
              hyperlink_id: cell.hyperlink_id,
            });
          } else {
            rowCells.push({ grapheme: '', cols: 1, sgr: '0x0000000000000000', hyperlink_id: 0 });
          }
        }
      } else {
        for (let c = 0; c < cols; c += 1) {
          rowCells.push({ grapheme: '', cols: 1, sgr: '0x0000000000000000', hyperlink_id: 0 });
        }
      }
      cells.push(rowCells);
    }
    const cursor = mirror.getCursor();
    return {
      rows,
      cols,
      cells,
      cursor: { row: cursor.row, col: cursor.col, visible: cursor.visible },
      mode: mirror.getMode() as Record<string, boolean | number | string | undefined>,
    };
  }, [mirror]);

  // Schedule the diff on every N frames.
  useEffect(() => {
    let frameCount = 0;
    const unsub = canvasSource.subscribe(() => {
      frameCount += 1;
      if (frameCount < diffIntervalFrames) return;
      frameCount = 0;
      if (!recorderRef.current) return;
      const canvas = snapshotCanvas();
      // No override → parity with canvas (zero-diff baseline).
      const reference = xtermSnapshot?.() ?? canvas;
      const diffs = diffFrames(canvas, reference);
      const snap: DiffSnapshot = { frameAt: Date.now(), diffs };
      recorderRef.current.record(snap);
      onDiff?.(snap);
      setSummary((prev) => ({
        cells: prev.cells + diffs.filter((d): d is Diff => d.kind === 'cell').length,
        frames: prev.frames + 1,
      }));
      if (diffs.length > 0) {
        log.debug('side-by-side: diff', diffs.length, 'entries');
      }
    });
    return () => unsub();
  }, [canvasSource, diffIntervalFrames, snapshotCanvas, xtermSnapshot, onDiff]);

  const handleExport = useCallback(() => {
    if (!recorderRef.current) return;
    const json = recorderRef.current.exportJson();
    onExportDiff?.(json);
    if (!onExportDiff && typeof document !== 'undefined') {
      // Fallback: trigger a browser download when the caller doesn't handle
      // the payload explicitly. Dev-only path.
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `side-by-side-diff-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [onExportDiff]);

  const summaryText = useMemo(() => {
    if (summary.frames === 0) return t('sideBySide.diffSummaryZero');
    return t('sideBySide.diffSummary', { count: summary.cells, frames: summary.frames });
  }, [summary]);

  return (
    <div className={styles.root} data-testid="side-by-side-harness" data-renderer="side-by-side">
      <div className={styles.pane} data-renderer="canvas" data-testid="side-by-side-canvas">
        <span className={styles.paneLabel}>{t('sideBySide.canvasLabel')}</span>
        <TerminalCanvas
          mirror={mirror}
          mirrorSource={canvasSource}
          backend="canvas"
          data-renderer="canvas"
        />
      </div>
      {/* historical-xterm-reference: the right pane used to mount the legacy
          xterm shell. It now mounts a second TerminalCanvas fed from the same
          mirror — useful as a regression sentinel against canvas-only bugs.
          `data-renderer="xterm"` is preserved for selector stability in
          any existing dev/e2e tooling. */}
      <div className={styles.pane} data-renderer="xterm" data-testid="side-by-side-xterm">
        <span className={styles.paneLabel}>{t('sideBySide.xtermLabel')}</span>
        <TerminalCanvas
          mirror={mirror}
          mirrorSource={canvasSource}
          backend="memory"
          data-renderer="xterm"
        />
      </div>
      <div className={styles.overlay} data-testid="side-by-side-overlay">
        <span>{summaryText}</span>
        <button type="button" className={styles.button} onClick={handleExport}>
          {t('sideBySide.exportDiff')}
        </button>
      </div>
    </div>
  );
}

SideBySideHarness.displayName = 'SideBySideHarness';
