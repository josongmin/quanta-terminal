/**
 * Canvas2DBackend font resilience — tab-switch / late-font-load bug.
 *
 * The original bug: `Canvas2DBackend.paintRows` called `ctx.fillText` without
 * ever setting `ctx.font`. The Canvas2D default is "10px sans-serif", so the
 * terminal rendered in a proportional font instead of the JetBrains Mono
 * stack. After a tab switch (and the accompanying canvas-size reset /
 * visibility change cycle) any context state that HAD been set upstream
 * could drift, exposing the default.
 *
 * The covered defensive paths:
 *   1. On mount, `ctx.font` is set to the mono stack.
 *   2. `applyMetrics` recomputes + reapplies the font.
 *   3. `paintRows` reapplies the font if it ever drifts.
 *   4. `document.fonts.ready` resolution triggers an atlas invalidation +
 *      the upstream hook (so the Renderer schedules a fresh rAF).
 *   5. `visibilitychange → visible` triggers the same refresh.
 *
 * NOTE: Tauri-specific timing — a true end-to-end reproduction requires the
 * WebView's context state behavior, which jsdom does not emulate. These
 * tests cover the defensive paths that handle the bug in production.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Canvas2DBackend } from '../../../shared/ui/cell-renderer/backend/Canvas2DBackend.js';
import type { CellMetrics } from '../../../shared/ui/cell-renderer/types.js';

const METRICS: CellMetrics = {
  cellWidthPx: 8,
  cellHeightPx: 16,
  baselineOffsetPx: 12,
  cellWidthCssPx: 8,
  cellHeightCssPx: 16,
};

/** Install a faux 2D context on HTMLCanvasElement.getContext so we can
 *  observe every state mutation. jsdom returns null by default. */
function installFakeCanvas2D(): {
  restore: () => void;
  instances: Array<FakeCtx>;
} {
  const instances: FakeCtx[] = [];
  const orig = HTMLCanvasElement.prototype.getContext;
  const getCtx = function getContext(this: HTMLCanvasElement, id: string) {
    if (id !== '2d') return (orig as unknown as (...a: unknown[]) => unknown).call(this, id);
    const c = new FakeCtx();
    instances.push(c);
    return c as unknown as CanvasRenderingContext2D;
  };
  // Must bypass the strict signature mismatch on replacement.
  (HTMLCanvasElement.prototype as unknown as { getContext: typeof getCtx }).getContext = getCtx;
  return {
    instances,
    restore: () => {
      (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = orig;
    },
  };
}

class FakeCtx {
  font = '10px sans-serif'; // Canvas2D default — the pre-fix symptom.
  textBaseline: CanvasTextBaseline = 'alphabetic';
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  lineWidth = 1;
  fillTextCalls: Array<{ text: string; x: number; y: number; fontAtCall: string }> = [];
  clearRect = vi.fn();
  fillRect = vi.fn();
  fillText(text: string, x: number, y: number): void {
    this.fillTextCalls.push({ text, x, y, fontAtCall: this.font });
  }
  measureText(): TextMetrics {
    return { width: 0 } as TextMetrics;
  }
}

describe('Canvas2DBackend — font resilience', () => {
  let fake: ReturnType<typeof installFakeCanvas2D>;
  let container: HTMLElement;
  let backend: Canvas2DBackend;

  beforeEach(() => {
    fake = installFakeCanvas2D();
    container = document.createElement('div');
    document.body.appendChild(container);
    backend = new Canvas2DBackend();
  });

  afterEach(() => {
    backend.unmount();
    fake.restore();
    document.body.removeChild(container);
  });

  it('applies a mono font string to ctx.font on mount (not the Canvas2D default)', () => {
    backend.mount({ container, metrics: METRICS, dpr: 1 });
    const ctx = fake.instances[0];
    expect(ctx).toBeDefined();
    expect(ctx!.font).not.toBe('10px sans-serif');
    expect(ctx!.font).toMatch(/JetBrains Mono/);
    // Size derived from cellHeight × 0.8 rounded: 16 × 0.8 = 12.8 → 13.
    expect(ctx!.font).toMatch(/^1[23]px/);
  });

  it('sets textBaseline to "alphabetic" on mount', () => {
    backend.mount({ container, metrics: METRICS, dpr: 1 });
    const ctx = fake.instances[0];
    expect(ctx!.textBaseline).toBe('alphabetic');
  });

  it('recomputes font string on applyMetrics', () => {
    backend.mount({ container, metrics: METRICS, dpr: 1 });
    const ctx = fake.instances[0];
    const beforeSize = ctx!.font;
    backend.applyMetrics({ ...METRICS, cellHeightPx: 32 }, 1);
    expect(ctx!.font).not.toBe(beforeSize);
    // 32 × 0.8 = 25.6 → 26.
    expect(ctx!.font).toMatch(/^(25|26)px.*JetBrains Mono/);
  });

  it('fillText always runs with the mono font (defensive paintRows reapply)', () => {
    backend.mount({ container, metrics: METRICS, dpr: 1 });
    const ctx = fake.instances[0];
    // Simulate context state drift (e.g., tab switch resetting canvas).
    ctx!.font = '10px sans-serif';
    // Drive a paint.
    backend.applyGridSnapshot(
      [
        {
          cells: [
            { grapheme: 'A', cols: 1, sgr: '0x0', hyperlink_id: 0, ext: null },
          ],
          continuation: false,
          revision: 1,
        },
      ],
      null,
      {},
    );
    expect(ctx!.fillTextCalls.length).toBeGreaterThan(0);
    // Every fillText must have happened after the font was re-set.
    for (const call of ctx!.fillTextCalls) {
      expect(call.fontAtCall).toMatch(/JetBrains Mono/);
      expect(call.fontAtCall).not.toBe('10px sans-serif');
    }
  });

  it('visibilitychange → visible fires the invalidation hook + logs a refresh', () => {
    backend.mount({ container, metrics: METRICS, dpr: 1 });
    const hook = vi.fn();
    backend._setInvalidationHook(hook);

    // Simulate: tab becomes hidden, then visible.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(hook).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(hook).toHaveBeenCalledTimes(1);

    // The paint log should record the visibility refresh.
    const log = backend._paintLog();
    expect(log.some((e) => e.kind === 'visibility_refresh')).toBe(true);
  });

  it('unmount detaches visibilitychange listener — subsequent events are no-ops', () => {
    backend.mount({ container, metrics: METRICS, dpr: 1 });
    const hook = vi.fn();
    backend._setInvalidationHook(hook);
    backend.unmount();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(hook).not.toHaveBeenCalled();
  });

  it('document.fonts.ready resolution triggers a refresh (production path)', async () => {
    // Install a fake FontFaceSet so the mount-time probe resolves.
    const loadSpy = vi.fn().mockResolvedValue([]);
    const readyResolve: { resolve: () => void } = { resolve: () => undefined };
    const ready = new Promise<void>((res) => {
      readyResolve.resolve = res;
    });
    const fakeFonts = { load: loadSpy, ready } as unknown as FontFaceSet;
    const prior = (document as Document & { fonts?: FontFaceSet }).fonts;
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      get: () => fakeFonts,
    });

    backend = new Canvas2DBackend();
    backend.mount({ container, metrics: METRICS, dpr: 1 });
    const hook = vi.fn();
    backend._setInvalidationHook(hook);

    // Resolve both paths — `load()` promise and `ready` promise.
    readyResolve.resolve();
    // Flush microtasks so the .then callbacks run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // At least one of the fonts-ready listeners should have fired the hook.
    expect(hook).toHaveBeenCalled();
    const log = backend._paintLog();
    expect(log.some((e) => e.kind === 'fonts_ready')).toBe(true);

    // Restore.
    if (prior) {
      Object.defineProperty(document, 'fonts', {
        configurable: true,
        get: () => prior,
      });
    } else {
      delete (document as unknown as { fonts?: FontFaceSet }).fonts;
    }
  });
});
