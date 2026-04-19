import { describe, expect, it } from 'vitest';

import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';

describe('ModeSnapshot', () => {
  it('returns a deeply frozen snapshot', () => {
    const mirror = createStubMirror({ decckm: true, bracketedPaste: true });
    const snap = new ModeSnapshot(mirror).read();

    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      (snap as { decckm: boolean }).decckm = false;
    }).toThrow();
  });

  it('decouples snapshot from subsequent mirror mutation', () => {
    const mirror = createStubMirror({ bracketedPaste: true });
    const reader = new ModeSnapshot(mirror);
    const first = reader.read();

    mirror.applyMode({ bracketedPaste: false });

    expect(first.bracketedPaste).toBe(true);
    expect(reader.read().bracketedPaste).toBe(false);
  });

  it('emits independent snapshots on successive reads', () => {
    const mirror = createStubMirror();
    const reader = new ModeSnapshot(mirror);
    const a = reader.read();
    const b = reader.read();
    expect(a).not.toBe(b);
  });

  it('peekEpoch is monotonic', () => {
    const mirror = createStubMirror();
    const reader = new ModeSnapshot(mirror);
    const start = reader.peekEpoch();
    mirror.applyMode({ decckm: true });
    const next = reader.peekEpoch();
    expect(next > start).toBe(true);
  });

  it('snapshot epoch matches mirror epoch at read time', () => {
    const mirror = createStubMirror();
    mirror.applyMode({ decckm: true });
    mirror.applyMode({ bracketedPaste: true });
    const reader = new ModeSnapshot(mirror);
    const snap = reader.read();
    expect(snap.snapshotEpoch).toBe(2n);
  });
});
