/**
 * DamageSet — a sparse (row, col) set that coalesces mirror-dirty signals
 * into a single paint pass per rAF.
 *
 * Invariants:
 *   - Additive: `add`/`addRow` never shrink the set.
 *   - Reset-only on `drain()`: callers get a frozen view + an empty internal
 *     state. No implicit consumption during reads.
 *   - No DOM / canvas access. Pure data.
 */

export interface DamageSnapshot {
  readonly rows: ReadonlySet<number>;
  readonly cursorDirty: boolean;
  readonly overlayDirty: boolean;
  /** Scrollback growth since the last drain. Consumed by viewport shift code. */
  readonly scrollback: number;
}

export class DamageSet {
  private readonly _rows = new Set<number>();
  private _cursorDirty = false;
  private _overlayDirty = false;
  private _scrollback = 0;

  /** Mark a single row dirty. */
  addRow(row: number): void {
    if (Number.isInteger(row) && row >= 0) this._rows.add(row);
  }

  /** Mark a set of rows dirty in one go. */
  addRows(rows: Iterable<number>): void {
    for (const r of rows) this.addRow(r);
  }

  /** Mark the cursor layer dirty (blink / move). */
  markCursorDirty(): void {
    this._cursorDirty = true;
  }

  /** Mark the overlay layer dirty (IME / selection / search highlight). */
  markOverlayDirty(): void {
    this._overlayDirty = true;
  }

  /** Accumulate scrollback appended rows (may be called multiple times within
   *  one rAF window). */
  addScrollback(rows: number): void {
    if (rows > 0) this._scrollback += rows;
  }

  /** True if there is nothing to paint. */
  isEmpty(): boolean {
    return (
      this._rows.size === 0 &&
      !this._cursorDirty &&
      !this._overlayDirty &&
      this._scrollback === 0
    );
  }

  /** Read-only view of the current dirty set. Does NOT reset. */
  peek(): DamageSnapshot {
    return {
      rows: new Set(this._rows),
      cursorDirty: this._cursorDirty,
      overlayDirty: this._overlayDirty,
      scrollback: this._scrollback,
    };
  }

  /** Get the rows and reset. */
  drain(): DamageSnapshot {
    const snapshot = this.peek();
    this.reset();
    return snapshot;
  }

  /** Reset without reading. */
  reset(): void {
    this._rows.clear();
    this._cursorDirty = false;
    this._overlayDirty = false;
    this._scrollback = 0;
  }

  /** Compose another damage set into this one. */
  union(other: DamageSet): void {
    for (const r of other._rows) this._rows.add(r);
    if (other._cursorDirty) this._cursorDirty = true;
    if (other._overlayDirty) this._overlayDirty = true;
    if (other._scrollback > 0) this._scrollback += other._scrollback;
  }

  /** Number of dirty rows. */
  rowCount(): number {
    return this._rows.size;
  }

  /** Snapshot rows as a sorted array. */
  rowArray(): number[] {
    return [...this._rows].sort((a, b) => a - b);
  }

  /** Query a single row. */
  hasRow(row: number): boolean {
    return this._rows.has(row);
  }

  /** @internal for diagnostics. */
  get cursorDirty(): boolean {
    return this._cursorDirty;
  }
  /** @internal for diagnostics. */
  get overlayDirty(): boolean {
    return this._overlayDirty;
  }
}
