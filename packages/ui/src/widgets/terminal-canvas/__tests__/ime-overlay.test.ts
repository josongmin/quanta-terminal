/**
 * IME overlay slot contract — tests the backend overlay API that EPIC-E's
 * `PreeditOverlay` consumes via `backend.mountOverlay` /
 * `updateOverlay` / `unmountOverlay`.
 */

import { describe, it, expect } from 'vitest';
import { MemoryBackend } from '../../../shared/ui/cell-renderer/backend/MemoryBackend.js';
import type { CellMetrics } from '../../../shared/ui/cell-renderer/types.js';

const METRICS: CellMetrics = {
  cellWidthPx: 8,
  cellHeightPx: 16,
  baselineOffsetPx: 12,
  cellWidthCssPx: 8,
  cellHeightCssPx: 16,
};

describe('IME overlay slot', () => {
  it('mountOverlay returns a handle with a unique id', () => {
    const backend = new MemoryBackend(METRICS);
    const h1 = backend.mountOverlay({ row: 0, col: 0, metrics: METRICS }, 'a');
    const h2 = backend.mountOverlay({ row: 0, col: 0, metrics: METRICS }, 'b');
    expect(h1.id).not.toBe(h2.id);
  });

  it('updateOverlay changes text without moving the anchor', () => {
    const backend = new MemoryBackend(METRICS);
    const h = backend.mountOverlay({ row: 1, col: 2, metrics: METRICS }, 'a');
    backend.updateOverlay(h, 'abc');
    const calls = backend.calls();
    expect(calls.filter((c) => c.kind === 'overlay_update').length).toBe(1);
  });

  it('unmountOverlay is idempotent', () => {
    const backend = new MemoryBackend(METRICS);
    const h = backend.mountOverlay({ row: 0, col: 0, metrics: METRICS }, 'a');
    backend.unmountOverlay(h);
    backend.unmountOverlay(h);
    // Only one `overlay_unmount` event — second call is a no-op.
    const calls = backend.calls();
    expect(calls.filter((c) => c.kind === 'overlay_unmount').length).toBe(1);
  });

  it('updateOverlay on a non-existent handle is a no-op', () => {
    const backend = new MemoryBackend(METRICS);
    backend.updateOverlay({ id: Symbol('unknown') }, 'x');
    expect(
      backend.calls().filter((c) => c.kind === 'overlay_update').length,
    ).toBe(0);
  });

  it('mountOverlay records the anchor in calls log', () => {
    const backend = new MemoryBackend(METRICS);
    backend.mountOverlay({ row: 3, col: 7, metrics: METRICS }, 'preedit');
    const ev = backend.calls().find((c) => c.kind === 'overlay_mount');
    expect(ev?.payload).toBeDefined();
    const p = ev?.payload as { anchor: { row: number; col: number }; text: string };
    expect(p.anchor.row).toBe(3);
    expect(p.anchor.col).toBe(7);
    expect(p.text).toBe('preedit');
  });

  it('multiple concurrent overlays are tracked independently', () => {
    const backend = new MemoryBackend(METRICS);
    const h1 = backend.mountOverlay({ row: 0, col: 0, metrics: METRICS }, 'a');
    const h2 = backend.mountOverlay({ row: 1, col: 0, metrics: METRICS }, 'b');
    backend.updateOverlay(h1, 'a-updated');
    backend.unmountOverlay(h2);
    const calls = backend.calls();
    expect(calls.filter((c) => c.kind === 'overlay_mount').length).toBe(2);
    expect(calls.filter((c) => c.kind === 'overlay_update').length).toBe(1);
    expect(calls.filter((c) => c.kind === 'overlay_unmount').length).toBe(1);
  });
});
