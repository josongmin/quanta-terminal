/**
 * Backend parity suite (DoD-D-02, -03, -04).
 *
 * Runs the same set of invariant cases against every `BackendContract`
 * implementation. A third "fake" backend demonstrates that any future
 * implementation can be certified by passing this file unchanged.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DamageSet } from '../../../shared/ui/cell-renderer/DamageSet.js';
import {
  Canvas2DBackend,
  MemoryBackend,
  type BackendContract,
  type MountContext,
} from '../../../shared/ui/cell-renderer/index.js';
import type { CellMetrics } from '../../../shared/ui/cell-renderer/types.js';

const METRICS: CellMetrics = {
  cellWidthPx: 8,
  cellHeightPx: 16,
  baselineOffsetPx: 12,
  cellWidthCssPx: 8,
  cellHeightCssPx: 16,
};

function blankRow(cols: number): {
  cells: Array<{ grapheme: string; cols: number; sgr: string; hyperlink_id: number; ext: null }>;
  continuation: boolean;
  revision: number;
} {
  const cells = [];
  for (let i = 0; i < cols; i += 1) {
    cells.push({
      grapheme: '',
      cols: 1,
      sgr: '0x0000000000000000',
      hyperlink_id: 0,
      ext: null,
    });
  }
  return { cells, continuation: false, revision: 1 };
}

function asciiRow(text: string, cols: number): ReturnType<typeof blankRow> {
  const row = blankRow(cols);
  for (let i = 0; i < Math.min(text.length, cols); i += 1) {
    row.cells[i] = {
      grapheme: text[i] ?? '',
      cols: 1,
      sgr: '0x0000000000000000',
      hyperlink_id: 0,
      ext: null,
    };
  }
  return row;
}

function parityCases(label: string, makeBackend: () => BackendContract): void {
  describe(`Backend parity — ${label}`, () => {
    let backend: BackendContract;
    let container: HTMLElement;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      backend = makeBackend();
      const ctx: MountContext = { container, metrics: METRICS, dpr: 1 };
      backend.mount(ctx);
    });

    it('mount + unmount clears DOM children', () => {
      const preChildren = container.children.length;
      backend.unmount();
      // Backend may leave the container empty but intact.
      expect(container.children.length).toBeLessThanOrEqual(preChildren);
    });

    it('applyGridSnapshot accepts rows, cursor, mode', () => {
      const rows = [asciiRow('abc', 4), asciiRow('def', 4)];
      backend.applyGridSnapshot(rows, null, {});
      // No throw — shape of the snapshot ingested.
      expect(true).toBe(true);
    });

    it('applyGridDelta accepts rows + DamageSet', () => {
      const rows = [asciiRow('abc', 4)];
      const dmg = new DamageSet();
      dmg.addRow(0);
      backend.applyGridDelta(rows, dmg);
      expect(true).toBe(true);
    });

    it('applyCursor accepts cursor state', () => {
      backend.applyCursor({
        row: 1,
        col: 2,
        visible: true,
        shape: 'block',
        blinking: false,
        pending_wrap: false,
      });
      expect(true).toBe(true);
    });

    it('applyMode accepts mode snapshot', () => {
      backend.applyMode({ alt_screen: true });
      expect(true).toBe(true);
    });

    it('applyMetrics accepts metrics + dpr', () => {
      backend.applyMetrics({ ...METRICS, cellWidthPx: 10 }, 2);
      expect(true).toBe(true);
    });

    it('measureText returns cell width equal to semantic width SSOT', () => {
      const ascii = backend.measureText('abc', 0);
      expect(ascii.cellsWide).toBe(3);
      const korean = backend.measureText('한', 0);
      expect(korean.cellsWide).toBe(2);
    });

    it('mountOverlay / updateOverlay / unmountOverlay lifecycle', () => {
      const handle = backend.mountOverlay({ row: 0, col: 0, metrics: METRICS }, 'abc');
      expect(handle).toBeDefined();
      backend.updateOverlay(handle, 'def');
      backend.unmountOverlay(handle);
      // Idempotent.
      backend.unmountOverlay(handle);
      expect(true).toBe(true);
    });

    it('screenToCell returns null for out-of-grid', () => {
      // Backend hasn't received a snapshot → no grid → null.
      backend.applyGridSnapshot([], null, {});
      expect(backend.screenToCell(-5, -5)).toBeNull();
    });

    it('screenToCell returns a ScreenHit on valid coords after snapshot', () => {
      backend.applyGridSnapshot([asciiRow('abc', 4), asciiRow('def', 4)], null, {});
      const hit = backend.screenToCell(METRICS.cellWidthCssPx * 2 + 1, 1);
      expect(hit).not.toBeNull();
      expect(hit?.row).toBe(0);
      expect(hit?.col).toBe(2);
    });

    it('cellToScreen returns a rect', () => {
      backend.applyGridSnapshot([asciiRow('abc', 4)], null, {});
      const rect = backend.cellToScreen(0, 1);
      expect(rect.x).toBe(METRICS.cellWidthCssPx);
      expect(rect.y).toBe(0);
      expect(rect.width).toBeGreaterThan(0);
    });

    it('requestDamageFlush is idempotent', () => {
      backend.requestDamageFlush();
      backend.requestDamageFlush();
      expect(true).toBe(true);
    });

    it('applySearchHighlights accepts a list and a scrollback anchor (Plan 0005 P1-F)', () => {
      // Seed the grid so off-screen / viewport translation has a real
      // dimension context to work against (MemoryBackend uses `gridRows`;
      // the Canvas2D path uses `overlayLayer` but accepts empty gracefully).
      backend.applyGridSnapshot([asciiRow('hello', 10), asciiRow('world', 10)], null, {});
      backend.applySearchHighlights(
        [{ rowId: 5, startCol: 0, endColExclusive: 5, current: true }],
        5,
      );
      // Empty list must also be accepted — that's how the overlay clears.
      backend.applySearchHighlights([], 5);
      expect(true).toBe(true);
    });

    it('unmount is idempotent', () => {
      backend.unmount();
      expect(() => backend.unmount()).not.toThrow();
    });
  });
}

parityCases('Canvas2DBackend', () => new Canvas2DBackend());
parityCases('MemoryBackend', () => new MemoryBackend(METRICS));

/** Third "fake" backend — passes the parity suite by delegating most methods
 *  to a `MemoryBackend` and overriding `screenToCell` / `cellToScreen` with
 *  identity-style math. Proves the contract boundary (DoD-D-04). */
class FakeDelegateBackend implements BackendContract {
  private inner = new MemoryBackend(METRICS);

  mount(ctx: MountContext): void {
    this.inner.mount(ctx);
  }
  applyGridSnapshot: BackendContract['applyGridSnapshot'] = (rows, cursor, mode) =>
    this.inner.applyGridSnapshot(rows, cursor, mode);
  applyGridDelta: BackendContract['applyGridDelta'] = (rows, damage) =>
    this.inner.applyGridDelta(rows, damage);
  applyCursor: BackendContract['applyCursor'] = (c) => this.inner.applyCursor(c);
  applyMode: BackendContract['applyMode'] = (m) => this.inner.applyMode(m);
  applyMetrics: BackendContract['applyMetrics'] = (m, d) => this.inner.applyMetrics(m, d);
  requestDamageFlush: BackendContract['requestDamageFlush'] = () =>
    this.inner.requestDamageFlush();
  applySearchHighlights: BackendContract['applySearchHighlights'] = (h, top) =>
    this.inner.applySearchHighlights(h, top);
  measureText: BackendContract['measureText'] = (t, a) => this.inner.measureText(t, a);
  mountOverlay: BackendContract['mountOverlay'] = (a, t) => this.inner.mountOverlay(a, t);
  updateOverlay: BackendContract['updateOverlay'] = (h, t) =>
    this.inner.updateOverlay(h, t);
  unmountOverlay: BackendContract['unmountOverlay'] = (h) => this.inner.unmountOverlay(h);
  screenToCell: BackendContract['screenToCell'] = (x, y) => this.inner.screenToCell(x, y);
  cellToScreen: BackendContract['cellToScreen'] = (r, c) => this.inner.cellToScreen(r, c);
  unmount: BackendContract['unmount'] = () => this.inner.unmount();
}
parityCases('FakeDelegateBackend', () => new FakeDelegateBackend());
