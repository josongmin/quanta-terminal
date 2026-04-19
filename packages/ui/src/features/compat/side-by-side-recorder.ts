/**
 * side-by-side-recorder — ring buffer for diff snapshots.
 *
 * Holds the last `capacity` `DiffSnapshot`s (one per scheduled diff). On
 * export, the recorder serializes the ring to JSON that the dev-tools
 * button downloads. See EPIC-H §4.3.2.
 */

import type { Diff } from './side-by-side-diff.js';

export interface DiffSnapshot {
  readonly frameAt: number;
  readonly diffs: readonly Diff[];
}

export interface SideBySideRecorderOptions {
  /** Maximum number of snapshots held. Default 256. */
  readonly capacity?: number;
}

export class SideBySideRecorder {
  private readonly capacity: number;
  private readonly buffer: DiffSnapshot[] = [];
  private head = 0;

  constructor(options: SideBySideRecorderOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 256);
  }

  record(snapshot: DiffSnapshot): void {
    if (this.buffer.length < this.capacity) {
      this.buffer.push(snapshot);
      return;
    }
    this.buffer[this.head] = snapshot;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Snapshots in insertion order (oldest → newest). */
  entries(): readonly DiffSnapshot[] {
    if (this.buffer.length < this.capacity) return this.buffer.slice();
    const out: DiffSnapshot[] = [];
    for (let i = 0; i < this.capacity; i += 1) {
      const idx = (this.head + i) % this.capacity;
      const snap = this.buffer[idx];
      if (snap) out.push(snap);
    }
    return out;
  }

  clear(): void {
    this.buffer.length = 0;
    this.head = 0;
  }

  /** JSON string suitable for download. */
  exportJson(): string {
    return JSON.stringify(
      {
        schema: 'side-by-side-diff/1',
        snapshots: this.entries().map((snap) => ({
          frameAt: snap.frameAt,
          diffs: snap.diffs.map((d) => {
            if (d.kind === 'input') {
              return {
                kind: d.kind,
                at: d.at,
                canvasBytes: Array.from(d.canvasBytes),
                xtermBytes: Array.from(d.xtermBytes),
              };
            }
            return d;
          }),
        })),
      },
      null,
      2,
    );
  }
}
