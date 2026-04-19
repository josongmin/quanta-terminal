import { describe, it, expect } from 'vitest';
import { DamageSet } from '../DamageSet.js';

describe('DamageSet', () => {
  it('is empty by default', () => {
    const d = new DamageSet();
    expect(d.isEmpty()).toBe(true);
    expect(d.rowCount()).toBe(0);
  });

  it('addRow marks the row dirty', () => {
    const d = new DamageSet();
    d.addRow(5);
    expect(d.hasRow(5)).toBe(true);
    expect(d.rowCount()).toBe(1);
    expect(d.isEmpty()).toBe(false);
  });

  it('addRows accepts iterables', () => {
    const d = new DamageSet();
    d.addRows([1, 2, 3]);
    expect(d.rowArray()).toEqual([1, 2, 3]);
  });

  it('ignores negative rows and non-integers', () => {
    const d = new DamageSet();
    d.addRow(-1);
    d.addRow(1.5);
    expect(d.isEmpty()).toBe(true);
  });

  it('coalesces duplicate row adds', () => {
    const d = new DamageSet();
    d.addRow(3);
    d.addRow(3);
    d.addRow(3);
    expect(d.rowCount()).toBe(1);
  });

  it('tracks cursor and overlay dirty flags independently', () => {
    const d = new DamageSet();
    d.markCursorDirty();
    expect(d.cursorDirty).toBe(true);
    expect(d.overlayDirty).toBe(false);
    expect(d.isEmpty()).toBe(false);
    d.markOverlayDirty();
    expect(d.overlayDirty).toBe(true);
  });

  it('drain() returns a snapshot and resets state', () => {
    const d = new DamageSet();
    d.addRows([1, 2, 5]);
    d.markCursorDirty();
    const snap = d.drain();
    expect([...snap.rows].sort()).toEqual([1, 2, 5]);
    expect(snap.cursorDirty).toBe(true);
    expect(d.isEmpty()).toBe(true);
  });

  it('peek() is non-destructive', () => {
    const d = new DamageSet();
    d.addRow(7);
    d.peek();
    d.peek();
    expect(d.rowCount()).toBe(1);
  });

  it('union merges a second damage set', () => {
    const a = new DamageSet();
    a.addRows([1, 2]);
    a.markCursorDirty();
    const b = new DamageSet();
    b.addRows([2, 3]);
    b.markOverlayDirty();
    a.union(b);
    expect(a.rowArray()).toEqual([1, 2, 3]);
    expect(a.cursorDirty).toBe(true);
    expect(a.overlayDirty).toBe(true);
  });

  it('scrollback addend accumulates', () => {
    const d = new DamageSet();
    d.addScrollback(3);
    d.addScrollback(2);
    expect(d.peek().scrollback).toBe(5);
    d.drain();
    expect(d.peek().scrollback).toBe(0);
  });

  it('reset clears everything', () => {
    const d = new DamageSet();
    d.addRow(1);
    d.markCursorDirty();
    d.markOverlayDirty();
    d.addScrollback(2);
    d.reset();
    expect(d.isEmpty()).toBe(true);
    expect(d.cursorDirty).toBe(false);
    expect(d.overlayDirty).toBe(false);
  });
});
