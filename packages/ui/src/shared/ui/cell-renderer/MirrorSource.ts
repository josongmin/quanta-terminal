/**
 * MirrorSource — a small observable adapter exposed to the cell-renderer so
 * `CellBuffer` can subscribe/unsubscribe without the caller having to know
 * that `GridMirror.onChange` is an options-time callback.
 *
 * Why this exists: EPIC-C's `GridMirror` takes `onChange` in its options at
 * construction. That's fine for the protocol adapter, but the cell-renderer
 * needs a runtime subscription pattern so tests can spy on subscriber counts
 * (leak detection, DoD-D-11).
 *
 * Usage:
 *   const source = new MirrorSource();
 *   const mirror = new GridMirror({ onChange: (dirty) => source.emit(dirty) });
 *   const cellBuffer = new CellBuffer(mirror, source);
 *
 * The `CellBuffer` calls `source.subscribe(handler)` once; `dispose()` calls
 * the returned unsubscribe thunk.
 */

import type { Unsubscribe } from './types.js';

export type MirrorChangeHandler = (dirtyRows: ReadonlySet<number>) => void;

export class MirrorSource {
  private readonly subs = new Set<MirrorChangeHandler>();

  subscribe(handler: MirrorChangeHandler): Unsubscribe {
    this.subs.add(handler);
    return () => {
      this.subs.delete(handler);
    };
  }

  emit(dirtyRows: ReadonlySet<number>): void {
    for (const h of this.subs) h(dirtyRows);
  }

  /** Number of active subscribers. Exposed for leak tests. */
  subscriberCount(): number {
    return this.subs.size;
  }

  /** Drop all subscribers. Called by the widget on unmount as a defensive
   *  net — individual CellBuffer / Renderer disposers should already have
   *  cleaned up. */
  clear(): void {
    this.subs.clear();
  }
}
