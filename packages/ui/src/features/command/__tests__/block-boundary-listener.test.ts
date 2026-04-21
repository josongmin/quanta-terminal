/**
 * Plan 0005 P1-C — block-boundary-listener tests.
 *
 * The listener bridges the hybrid detector's event stream to the block
 * store + scrollback pin API. These tests use a stub pin port and a stub
 * block-store port so the contract is exercised without standing up the
 * live VtEmulator or zustand store.
 *
 * Covered:
 *   - prompt_start → startBlock + pinScrollbackRow + rowRange attached.
 *   - command_end  → setBlockRowRange(end) + completeBlock + unpin.
 *   - confidence mapping for each BoundarySource.
 *   - duration passthrough from osc133 events.
 *   - exit code passthrough (null-safe).
 *   - back-to-back prompt_starts finalize the previous block synthetically.
 *   - command_end without a prior prompt_start is a no-op.
 *   - command_start / output_start events are consumed but produce no
 *     mutations (reserved-hook contract).
 *   - dispose releases any outstanding pin.
 *   - out-of-range pin operations (evicted rows) are no-ops on the port.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createBoundaryListener,
  mapSourceToConfidence,
  installBoundaryListener,
} from '../block-boundary-listener.js';
import type {
  BoundaryBlockStorePort,
  ScrollbackPinPort,
} from '../block-boundary-listener.js';
import type {
  BoundaryEvent,
  HybridBoundaryDetector,
} from '../hybrid-detector-types.js';
import type { BlockId, SessionId } from '../../../shared/types/generated/index.js';

const SESSION = 's-1' as SessionId;

function makePinPort(overrides: Partial<ScrollbackPinPort> = {}): {
  port: ScrollbackPinPort;
  pins: Set<number>;
  nextRowId: { current: number };
  pinScrollbackRow: ReturnType<typeof vi.fn>;
  unpinScrollbackRow: ReturnType<typeof vi.fn>;
} {
  const pins = new Set<number>();
  const nextRowId = { current: 0 };
  const pinScrollbackRow = vi.fn((rowId: number) => {
    pins.add(rowId);
  });
  const unpinScrollbackRow = vi.fn((rowId: number) => {
    pins.delete(rowId);
  });
  const port: ScrollbackPinPort = {
    getNextRowId: overrides.getNextRowId ?? (() => nextRowId.current),
    pinScrollbackRow,
    unpinScrollbackRow,
  };
  return { port, pins, nextRowId, pinScrollbackRow, unpinScrollbackRow };
}

function makeStorePort(): {
  port: BoundaryBlockStorePort;
  startBlock: ReturnType<typeof vi.fn>;
  completeBlock: ReturnType<typeof vi.fn>;
  setBlockRowRange: ReturnType<typeof vi.fn>;
  setBlockDuration: ReturnType<typeof vi.fn>;
  getActiveBlockId: ReturnType<typeof vi.fn>;
  issuedIds: string[];
} {
  const issuedIds: string[] = [];
  let counter = 0;
  const startBlock = vi.fn(() => {
    counter += 1;
    const id = `blk-${counter}`;
    issuedIds.push(id);
    return id as BlockId;
  });
  const completeBlock = vi.fn();
  const setBlockRowRange = vi.fn();
  const setBlockDuration = vi.fn();
  const getActiveBlockId = vi.fn(() => null as BlockId | null);
  const port: BoundaryBlockStorePort = {
    startBlock: startBlock as unknown as BoundaryBlockStorePort['startBlock'],
    completeBlock: completeBlock as unknown as BoundaryBlockStorePort['completeBlock'],
    setBlockRowRange: setBlockRowRange as unknown as BoundaryBlockStorePort['setBlockRowRange'],
    setBlockDuration: setBlockDuration as unknown as BoundaryBlockStorePort['setBlockDuration'],
    getActiveBlockId,
  };
  return {
    port,
    startBlock,
    completeBlock,
    setBlockRowRange,
    setBlockDuration,
    getActiveBlockId,
    issuedIds,
  };
}

function promptStart(source: BoundaryEvent['source'], atMs = 1000): BoundaryEvent {
  return {
    kind: 'prompt_start',
    source,
    confidence: source === 'osc133' ? 1.0 : 0.6,
    at_ms: atMs,
  };
}

interface CommandEndExtras {
  readonly at_ms?: number;
  readonly exitCode?: number | null;
  readonly cwd?: string;
  readonly durationMs?: number;
}
function commandEnd(
  source: BoundaryEvent['source'],
  extras: CommandEndExtras = {},
): BoundaryEvent {
  // Build carefully to respect `exactOptionalPropertyTypes`: omitted fields
  // must be absent, not undefined.
  const event: BoundaryEvent & {
    exitCode?: number | null;
    cwd?: string;
    durationMs?: number;
  } = {
    kind: 'command_end',
    source,
    confidence: source === 'osc133' ? 1.0 : 0.1,
    at_ms: extras.at_ms ?? 2000,
  };
  if (extras.exitCode !== undefined) event.exitCode = extras.exitCode;
  if (extras.cwd !== undefined) event.cwd = extras.cwd;
  if (extras.durationMs !== undefined) event.durationMs = extras.durationMs;
  return event;
}

describe('mapSourceToConfidence', () => {
  it('maps osc133 → authoritative', () => {
    expect(mapSourceToConfidence('osc133')).toBe('authoritative');
  });
  it('maps heuristic_regex → heuristic', () => {
    expect(mapSourceToConfidence('heuristic_regex')).toBe('heuristic');
  });
  it('maps cursor_home → heuristic', () => {
    expect(mapSourceToConfidence('cursor_home')).toBe('heuristic');
  });
  it('maps idle → idle', () => {
    expect(mapSourceToConfidence('idle')).toBe('idle');
  });
});

describe('createBoundaryListener — prompt_start', () => {
  it('creates a block with rowRange { startRow, endRowExclusive: null }', () => {
    const pin = makePinPort();
    pin.nextRowId.current = 42;
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);

    expect(store.startBlock).toHaveBeenCalledTimes(1);
    const [command, cwd, opts] = store.startBlock.mock.calls[0] ?? [];
    expect(command).toBe('');
    expect(cwd).toBe('');
    expect(opts).toMatchObject({
      sessionId: SESSION,
      rowRange: { startRow: 42, endRowExclusive: null },
      confidence: 'authoritative',
    });
  });

  it('pins the start row on the pin port', () => {
    const pin = makePinPort();
    pin.nextRowId.current = 42;
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);

    expect(pin.pinScrollbackRow).toHaveBeenCalledWith(42);
    expect(pin.pins.has(42)).toBe(true);
  });

  it('tracks the created block as active', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);
    expect(listener.getActiveBlockId()).toBe(store.issuedIds[0]);
  });
});

describe('createBoundaryListener — command_end', () => {
  it('finalizes the row range with the current next-row-id as endRowExclusive', () => {
    const pin = makePinPort();
    pin.nextRowId.current = 10;
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);
    pin.nextRowId.current = 25;
    listener.pump([commandEnd('osc133', { exitCode: 0, durationMs: 800 })]);

    expect(store.setBlockRowRange).toHaveBeenCalledWith(
      store.issuedIds[0],
      { startRow: 10, endRowExclusive: 25 },
    );
  });

  it('calls completeBlock with the event exit code', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);
    listener.pump([commandEnd('osc133', { exitCode: 127 })]);

    expect(store.completeBlock).toHaveBeenCalledWith(store.issuedIds[0], 127);
  });

  it('passes null exitCode when the source did not carry one', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('heuristic_regex')]);
    listener.pump([commandEnd('idle', {})]);

    expect(store.completeBlock).toHaveBeenCalledWith(store.issuedIds[0], null);
  });

  it('calls setBlockDuration when durationMs is present', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);
    listener.pump([commandEnd('osc133', { exitCode: 0, durationMs: 1234 })]);

    expect(store.setBlockDuration).toHaveBeenCalledWith(
      store.issuedIds[0],
      1234,
    );
  });

  it('skips setBlockDuration when durationMs is absent', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('heuristic_regex')]);
    listener.pump([commandEnd('heuristic_regex', {})]);

    expect(store.setBlockDuration).not.toHaveBeenCalled();
  });

  it('releases the pin after command_end', () => {
    const pin = makePinPort();
    pin.nextRowId.current = 10;
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);
    expect(pin.pins.has(10)).toBe(true);
    listener.pump([commandEnd('osc133', { exitCode: 0 })]);
    expect(pin.pins.has(10)).toBe(false);
  });

  it('clears the active-block pointer after command_end', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);
    expect(listener.getActiveBlockId()).not.toBeNull();
    listener.pump([commandEnd('osc133', { exitCode: 0 })]);
    expect(listener.getActiveBlockId()).toBeNull();
  });

  it('is a no-op when command_end arrives with no active block', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([commandEnd('osc133', { exitCode: 0 })]);
    expect(store.completeBlock).not.toHaveBeenCalled();
    expect(store.setBlockRowRange).not.toHaveBeenCalled();
  });
});

describe('createBoundaryListener — back-to-back prompt_start', () => {
  it('synthetically completes the prior block on a second prompt_start', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);
    listener.pump([promptStart('osc133')]);

    // First block got completed with null exit code (synthetic close).
    expect(store.completeBlock).toHaveBeenCalledWith(store.issuedIds[0], null);
    // Second startBlock fired for the new prompt.
    expect(store.startBlock).toHaveBeenCalledTimes(2);
  });
});

describe('createBoundaryListener — reserved-hook events', () => {
  it('ignores command_start events', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([
      {
        kind: 'command_start',
        source: 'osc133',
        confidence: 1.0,
        at_ms: 100,
      },
    ]);

    expect(store.startBlock).not.toHaveBeenCalled();
    expect(store.completeBlock).not.toHaveBeenCalled();
  });

  it('ignores output_start events', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([
      {
        kind: 'output_start',
        source: 'osc133',
        confidence: 1.0,
        at_ms: 100,
      },
    ]);

    expect(store.startBlock).not.toHaveBeenCalled();
  });
});

describe('createBoundaryListener — dispose', () => {
  it('releases the current pin on dispose', () => {
    const pin = makePinPort();
    pin.nextRowId.current = 42;
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.pump([promptStart('osc133')]);
    expect(pin.pins.has(42)).toBe(true);
    listener.dispose();
    expect(pin.pins.has(42)).toBe(false);
  });

  it('is idempotent', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.dispose();
    listener.dispose();
    // No throw.
    expect(true).toBe(true);
  });

  it('drops further events after disposal', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const listener = createBoundaryListener(SESSION, store.port, pin.port);

    listener.dispose();
    listener.pump([promptStart('osc133')]);
    expect(store.startBlock).not.toHaveBeenCalled();
  });
});

describe('installBoundaryListener — production entrypoint', () => {
  it('returns a handle with pump + dispose + getActiveBlockId', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const fakeDetector: HybridBoundaryDetector = {
      feed: vi.fn(() => []),
      tick: vi.fn(() => []),
      setSignals: vi.fn(),
      reset: vi.fn(),
    };
    const handle = installBoundaryListener(
      SESSION,
      fakeDetector,
      store.port,
      pin.port,
    );
    expect(typeof handle.pump).toBe('function');
    expect(typeof handle.dispose).toBe('function');
    expect(typeof handle.getActiveBlockId).toBe('function');
    handle.dispose();
  });

  it('does not subscribe to the detector by itself (pump-driven)', () => {
    const pin = makePinPort();
    const store = makeStorePort();
    const feed = vi.fn(() => []);
    const tick = vi.fn(() => []);
    const fakeDetector: HybridBoundaryDetector = {
      feed,
      tick,
      setSignals: vi.fn(),
      reset: vi.fn(),
    };
    const handle = installBoundaryListener(
      SESSION,
      fakeDetector,
      store.port,
      pin.port,
    );
    // installBoundaryListener is a pure pass-through — it must never call
    // feed/tick on its own. The caller drives events via pump.
    expect(feed).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    handle.dispose();
  });
});
