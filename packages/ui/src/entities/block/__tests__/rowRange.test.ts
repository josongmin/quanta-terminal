/**
 * Plan 0005 P1-C — row-range / confidence / duration Block entity tests.
 *
 * New fields on the Block entity (all optional / nullable for back-compat):
 *   - `rowRange`       : { startRow, endRowExclusive } | null
 *   - `confidence`     : 'authoritative' | 'heuristic' | 'idle' | 'synthetic' | null
 *   - `durationMs`     : number | null
 *
 * New actions:
 *   - `setBlockRowRange(id, range, confidence?)` — idempotent writer.
 *   - `setBlockDuration(id, ms)` — stamps duration on terminal blocks.
 *
 * Covered:
 *   - startBlock / createBlock accept rowRange + confidence via options.
 *   - Defaults are null / null / null when the options aren't provided.
 *   - setBlockRowRange writes a new range and confidence pair.
 *   - setBlockRowRange is idempotent when the value matches (no-op).
 *   - setBlockRowRange is a no-op on unknown block ids.
 *   - setBlockDuration only writes on terminal blocks.
 *   - setBlockDuration is idempotent on matching value.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlockStore } from '../model.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const SESSION = 'rowrange-test' as SessionId;

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('Block entity — P1-C new fields defaults', () => {
  it('createBlock without options leaves rowRange / confidence / durationMs null', () => {
    const id = useBlockStore.getState().createBlock('echo', '/');
    const b = useBlockStore.getState().entities[id];
    expect(b?.rowRange).toBeNull();
    expect(b?.confidence).toBeNull();
    expect(b?.durationMs).toBeNull();
  });

  it('startBlock without options leaves the new fields null', () => {
    const id = useBlockStore.getState().startBlock('ls', '/');
    const b = useBlockStore.getState().entities[id];
    expect(b?.rowRange).toBeNull();
    expect(b?.confidence).toBeNull();
    expect(b?.durationMs).toBeNull();
  });

  it('startBlock with rowRange + confidence options populates them', () => {
    const id = useBlockStore.getState().startBlock('pwd', '/', {
      sessionId: SESSION,
      rowRange: { startRow: 10, endRowExclusive: null },
      confidence: 'authoritative',
    });
    const b = useBlockStore.getState().entities[id];
    expect(b?.rowRange).toEqual({ startRow: 10, endRowExclusive: null });
    expect(b?.confidence).toBe('authoritative');
  });
});

describe('Block entity — setBlockRowRange', () => {
  it('updates rowRange on an existing block', () => {
    const id = useBlockStore.getState().startBlock('ls', '/');
    useBlockStore
      .getState()
      .setBlockRowRange(id, { startRow: 5, endRowExclusive: 9 }, 'heuristic');
    const b = useBlockStore.getState().entities[id];
    expect(b?.rowRange).toEqual({ startRow: 5, endRowExclusive: 9 });
    expect(b?.confidence).toBe('heuristic');
  });

  it('accepts null as a reset for the row range', () => {
    const id = useBlockStore.getState().startBlock('ls', '/', {
      rowRange: { startRow: 10, endRowExclusive: null },
      confidence: 'authoritative',
    });
    useBlockStore.getState().setBlockRowRange(id, null);
    const b = useBlockStore.getState().entities[id];
    expect(b?.rowRange).toBeNull();
  });

  it('preserves confidence when not passed on a subsequent update', () => {
    const id = useBlockStore.getState().startBlock('ls', '/', {
      confidence: 'authoritative',
    });
    useBlockStore
      .getState()
      .setBlockRowRange(id, { startRow: 20, endRowExclusive: 25 });
    const b = useBlockStore.getState().entities[id];
    expect(b?.confidence).toBe('authoritative');
    expect(b?.rowRange).toEqual({ startRow: 20, endRowExclusive: 25 });
  });

  it('is a no-op on an unknown block id', () => {
    const before = useBlockStore.getState().entities;
    useBlockStore
      .getState()
      .setBlockRowRange('nonexistent', { startRow: 0, endRowExclusive: 1 });
    expect(useBlockStore.getState().entities).toBe(before);
  });

  it('is idempotent (no subscriber notification on a matching write)', () => {
    const id = useBlockStore.getState().startBlock('ls', '/', {
      rowRange: { startRow: 5, endRowExclusive: 9 },
      confidence: 'heuristic',
    });
    const subscriber = vi.fn();
    const unsub = useBlockStore.subscribe(subscriber);
    try {
      useBlockStore
        .getState()
        .setBlockRowRange(
          id,
          { startRow: 5, endRowExclusive: 9 },
          'heuristic',
        );
      expect(subscriber).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });
});

describe('Block entity — setBlockDuration', () => {
  it('stamps duration on a completed block', () => {
    const id = useBlockStore.getState().startBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    useBlockStore.getState().setBlockDuration(id, 1234);
    const b = useBlockStore.getState().entities[id];
    expect(b?.durationMs).toBe(1234);
  });

  it('is a no-op on a running block', () => {
    const id = useBlockStore.getState().startBlock('ls', '/');
    useBlockStore.getState().setBlockDuration(id, 500);
    const b = useBlockStore.getState().entities[id];
    expect(b?.durationMs).toBeNull();
  });

  it('is a no-op on an unknown block id', () => {
    const before = useBlockStore.getState().entities;
    useBlockStore.getState().setBlockDuration('nonexistent', 200);
    expect(useBlockStore.getState().entities).toBe(before);
  });

  it('is idempotent on matching value', () => {
    const id = useBlockStore.getState().startBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    useBlockStore.getState().setBlockDuration(id, 1234);
    const subscriber = vi.fn();
    const unsub = useBlockStore.subscribe(subscriber);
    try {
      useBlockStore.getState().setBlockDuration(id, 1234);
      expect(subscriber).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });

  it('works for canceled and error terminal states', () => {
    const canceledId = useBlockStore.getState().startBlock('a', '/');
    useBlockStore.getState().cancelBlock(canceledId);
    useBlockStore.getState().setBlockDuration(canceledId, 42);
    expect(useBlockStore.getState().entities[canceledId]?.durationMs).toBe(42);

    const errId = useBlockStore.getState().startBlock('b', '/');
    useBlockStore.getState().errorBlock(errId, 'oops');
    useBlockStore.getState().setBlockDuration(errId, 55);
    expect(useBlockStore.getState().entities[errId]?.durationMs).toBe(55);
  });
});
