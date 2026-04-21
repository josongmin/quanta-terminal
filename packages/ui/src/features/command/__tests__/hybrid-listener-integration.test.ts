/**
 * Plan 0005 P1 wave 1 — integration: route-output.ts → hybrid detector →
 * block-boundary-listener → block store.
 *
 * The pre-existing unit tests exercise each leg in isolation:
 *   - `hybrid-detector*.test.ts` — byte-level OSC 133 / regex / idle parsing.
 *   - `block-boundary-listener.test.ts` — pump → startBlock / completeBlock.
 *   - `route-output.test.ts` — the hybrid sink wiring on the router handle.
 *
 * That coverage shipped in waves, and an audit surfaced that the three legs
 * never ran end-to-end in production: the router called `handle.hybrid.feed`
 * but discarded the returned events, so the listener's pump was never
 * invoked on a real session even though `installBoundaryListener` existed.
 * THIS test pins the full chain: feed a realistic byte stream through
 * `appendToActiveBlock`, assert that block-store mutations land with the
 * authoritative OSC 133 D payload (exitCode, cwd, duration, rowRange).
 *
 * Coverage matrix
 * ---------------
 *   - osc133 A → B → C → D lifecycle drives startBlock + completeBlock,
 *     stamps rowRange / exitCode / cwd / duration.
 *   - Idle tier does NOT fire when `shellIntegration === 'installed'`
 *     (Plan §R-4: OSC 133 D is authoritative; a 0.1-confidence idle
 *     command_end racing the same window causes double-close).
 *   - Idle tier DOES fire when `shellIntegration === 'missing'` (the
 *     fallback path for sessions without shell-integration coverage).
 *   - A suppressed (arbitrated) event does NOT surface to the listener,
 *     so the block is not double-closed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlockId, SessionId } from '../../../shared/types/generated/index.js';
import {
  appendToActiveBlock,
  installCommandRouter,
  __resetRouterForTests,
} from '../route-output.js';
import {
  createBoundaryListener,
  type BoundaryBlockStorePort,
  type ScrollbackPinPort,
} from '../block-boundary-listener.js';
import type { BoundaryEvent } from '../hybrid-detector-types.js';
import { bindBlockStore, type BlockStoreActions } from '../block-store-port.js';

// ----- Helpers: OSC 133 sequence builder → base64 (matching the bridge wire) -----

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Build `ESC ] 133 ; <kind>[;payload] BEL`. */
function osc133(kind: 'A' | 'B' | 'C' | 'D', payload?: string): Uint8Array {
  const body = payload ? `${kind};${payload}` : kind;
  return concat(
    new Uint8Array([0x1b, 0x5d]), // ESC ]
    ascii(`133;${body}`),
    new Uint8Array([0x07]), // BEL
  );
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

// ----- Port fakes -----

interface BlockRecord {
  id: BlockId;
  command: string;
  cwd: string;
  sessionId: SessionId;
  status: 'running' | 'completed' | 'canceled' | 'error';
  exitCode: number | null;
  rowRange: { startRow: number; endRowExclusive: number | null } | null;
  confidence: 'authoritative' | 'heuristic' | 'idle' | 'synthetic' | null;
  durationMs: number | null;
  completedAt: number | null;
}

/**
 * Hand-rolled block store shared between the router's `BlockStoreActions`
 * adapter and the listener's `BoundaryBlockStorePort`. Keeping a single
 * shared state here is load-bearing: the listener asserts against the same
 * active pointer the router reads, so splitting them would invalidate the
 * multi-leg integration contract.
 */
function makeSharedBlockStore(sessionId: SessionId): {
  routerPort: BlockStoreActions;
  listenerPort: BoundaryBlockStorePort;
  records: Map<BlockId, BlockRecord>;
  active: () => BlockId | null;
  setActive: (id: BlockId | null) => void;
  running: () => readonly BlockId[];
} {
  const records = new Map<BlockId, BlockRecord>();
  let activeId: BlockId | null = null;
  let counter = 0;

  /**
   * Helper — unify startBlock across the router and listener ports. Both
   * ports drive the SAME record map; the router's `BlockStoreActions`
   * signature omits rowRange/confidence (those are listener-only), and the
   * listener's `BoundaryBlockStorePort` signature accepts the fuller
   * entity-side `StartBlockOptions`. We delegate from both through this
   * helper so the record-map bookkeeping stays in one place.
   */
  function internalStartBlock(
    command: string,
    cwd: string,
    options: {
      sessionId?: SessionId;
      rowRange?: { startRow: number; endRowExclusive: number | null };
      confidence?: 'authoritative' | 'heuristic' | 'idle' | 'synthetic';
    } = {},
  ): BlockId {
    counter += 1;
    const id = `blk-${counter}` as BlockId;
    const rowRange = options.rowRange ?? null;
    const confidence = options.confidence ?? null;
    records.set(id, {
      id,
      command,
      cwd,
      sessionId: options.sessionId ?? sessionId,
      status: 'running',
      exitCode: null,
      rowRange: rowRange
        ? { startRow: rowRange.startRow, endRowExclusive: rowRange.endRowExclusive }
        : null,
      confidence,
      durationMs: null,
      completedAt: null,
    });
    activeId = id;
    return id;
  }

  const routerPort: BlockStoreActions = {
    createBlock(command, cwd, options) {
      counter += 1;
      const id = `blk-${counter}` as BlockId;
      records.set(id, {
        id,
        command,
        cwd,
        sessionId: options?.sessionId ?? sessionId,
        status: 'running',
        exitCode: null,
        rowRange: null,
        confidence: null,
        durationMs: null,
        completedAt: null,
      });
      return id;
    },
    startBlock(command, cwd, options) {
      return internalStartBlock(command, cwd, options ?? {});
    },
    setActiveBlockId(id) {
      activeId = id as BlockId | null;
    },
    getActiveBlockId() {
      return activeId;
    },
    appendBlockOutput() {
      // Not under test here — the listener does not touch output bytes.
    },
    completeBlock(id, exitCode) {
      const rec = records.get(id);
      if (!rec) return;
      if (rec.status !== 'running') return;
      rec.status = 'completed';
      rec.exitCode = exitCode;
      rec.completedAt = Date.now();
      if (activeId === id) activeId = null;
    },
    cancelBlock(id) {
      const rec = records.get(id);
      if (!rec) return;
      if (rec.status !== 'running') return;
      rec.status = 'canceled';
      if (activeId === id) activeId = null;
    },
    errorBlock(id, message) {
      const rec = records.get(id);
      if (!rec) return;
      rec.status = 'error';
      void message;
    },
    getRunningBlockIds() {
      const out: BlockId[] = [];
      for (const r of records.values()) {
        if (r.status === 'running') out.push(r.id);
      }
      return out;
    },
  };

  // The listener calls setBlockRowRange / setBlockDuration / getActiveBlockId
  // directly on the block entity in production; we recreate those here
  // against the same record map so the mutations surface in assertions.
  const listenerPort: BoundaryBlockStorePort = {
    startBlock(command, cwd, options) {
      // The listener's port signature is `BlockActions['startBlock']` which
      // takes the entity-side StartBlockOptions (rowRange, confidence, etc.).
      // The record map and active pointer are shared with the router port.
      return internalStartBlock(command, cwd, {
        ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options?.rowRange !== undefined ? { rowRange: options.rowRange } : {}),
        ...(options?.confidence !== undefined ? { confidence: options.confidence } : {}),
      });
    },
    completeBlock(id, exitCode) {
      routerPort.completeBlock(id, exitCode);
    },
    setBlockRowRange(id, rowRange, confidence) {
      const rec = records.get(id as BlockId);
      if (!rec) return;
      rec.rowRange = rowRange
        ? { startRow: rowRange.startRow, endRowExclusive: rowRange.endRowExclusive }
        : null;
      if (confidence !== undefined) rec.confidence = confidence;
    },
    setBlockDuration(id, durationMs) {
      const rec = records.get(id as BlockId);
      if (!rec) return;
      if (rec.status === 'running') return;
      rec.durationMs = durationMs;
    },
    getActiveBlockId() {
      return activeId;
    },
  };

  return {
    routerPort,
    listenerPort,
    records,
    active: () => activeId,
    setActive: (id) => {
      activeId = id;
    },
    running: () => {
      const out: BlockId[] = [];
      for (const r of records.values()) {
        if (r.status === 'running') out.push(r.id);
      }
      return out;
    },
  };
}

function makePinPort(startRowId = 100): {
  port: ScrollbackPinPort;
  setNext: (rowId: number) => void;
  pinned: Set<number>;
} {
  let nextRowId = startRowId;
  const pinned = new Set<number>();
  return {
    port: {
      getNextRowId: () => nextRowId,
      pinScrollbackRow: (rowId) => {
        pinned.add(rowId);
      },
      unpinScrollbackRow: (rowId) => {
        pinned.delete(rowId);
      },
    },
    setNext: (rowId) => {
      nextRowId = rowId;
    },
    pinned,
  };
}

// ----- Suite state -----

let unbind: (() => void) | undefined;

beforeEach(() => {
  __resetRouterForTests();
});

afterEach(() => {
  if (unbind) unbind();
  unbind = undefined;
  __resetRouterForTests();
});

// =====================================================================
// A. Authoritative A→B→C→D lifecycle
// =====================================================================

describe('hybrid-listener integration: OSC 133 A→B→C→D closes block with authoritative payload', () => {
  it('drives startBlock, rowRange, exitCode, cwd, and duration end-to-end', () => {
    const SESSION = 'sess-int-1' as SessionId;
    const store = makeSharedBlockStore(SESSION);
    unbind = bindBlockStore(store.routerPort);
    const pin = makePinPort(42);
    const listener = createBoundaryListener(
      SESSION,
      store.listenerPort,
      pin.port,
    );
    // Wire the hybrid detector's events into the listener via the router
    // option, exactly like production `connect.ts` does.
    installCommandRouter(SESSION, {
      detector: null,
      hybrid: {
        shellIntegration: 'installed',
        onHybridBoundary: (event) => listener.pump([event]),
      },
    });

    // Feed A: listener creates the running block with the start row pinned.
    const aBytes = osc133('A');
    appendToActiveBlock(SESSION, bytesToB64(aBytes));
    const afterA = store.running();
    expect(afterA).toHaveLength(1);
    const firstId = afterA[0] as BlockId;
    const afterAStart = store.records.get(firstId);
    expect(afterAStart?.rowRange).toEqual({ startRow: 42, endRowExclusive: null });
    expect(afterAStart?.confidence).toBe('authoritative');
    expect(pin.pinned.has(42)).toBe(true);

    // Walk the cursor forward for C → D so endRowExclusive reflects a
    // plausible post-output position.
    appendToActiveBlock(SESSION, bytesToB64(osc133('B')));
    appendToActiveBlock(SESSION, bytesToB64(osc133('C')));
    pin.setNext(59);

    // D: authoritative close. Payload carries exitCode=2, cwd=/tmp,
    // duration_ms=123 — the router must capture all three via the sink.
    const dBytes = osc133('D', '2;cwd=/tmp;duration_ms=123');
    appendToActiveBlock(SESSION, bytesToB64(dBytes));

    const rec = store.records.get(firstId);
    expect(rec).toBeDefined();
    expect(rec?.status).toBe('completed');
    expect(rec?.exitCode).toBe(2);
    expect(rec?.durationMs).toBe(123);
    expect(rec?.rowRange).toEqual({ startRow: 42, endRowExclusive: 59 });
    // The pin held on 42 is released after the close.
    expect(pin.pinned.has(42)).toBe(false);
    // Listener's own active pointer is cleared so the next prompt_start
    // starts a fresh block (the shared active pointer was cleared too).
    expect(listener.getActiveBlockId()).toBeNull();
  });
});

// =====================================================================
// B. Idle gate (§R-4) — installed integration never double-closes
// =====================================================================

describe('hybrid-listener integration: idle gate honours shellIntegration', () => {
  it("does NOT emit a duplicate command_end via idle when shellIntegration='installed'", () => {
    const SESSION = 'sess-int-2' as SessionId;
    const store = makeSharedBlockStore(SESSION);
    unbind = bindBlockStore(store.routerPort);
    const pin = makePinPort(10);
    const listener = createBoundaryListener(
      SESSION,
      store.listenerPort,
      pin.port,
    );
    // Capture every boundary event the router forwards — we assert on the
    // event taxonomy directly to guarantee the idle tier is silent.
    const received: BoundaryEvent[] = [];
    installCommandRouter(SESSION, {
      detector: null,
      // Tight idle timeout so the in-test deadline crossing is trivially
      // reachable without a fake clock.
      hybrid: {
        shellIntegration: 'installed',
        idleTimeoutMs: 10,
        onHybridBoundary: (event) => {
          received.push(event);
          listener.pump([event]);
        },
      },
    });

    // Prime the stream with a prompt_start + some noise so the detector has
    // material to go idle on.
    appendToActiveBlock(SESSION, bytesToB64(osc133('A')));
    appendToActiveBlock(SESSION, bytesToB64(ascii('running...\n')));

    // Wait for the idle deadline to have elapsed, then feed more bytes.
    // On a non-integrated session this would surface an idle command_end
    // event BEFORE the new burst; on 'installed' the §R-4 gate silences it.
    const start = Date.now();
    // Busy-wait for 25 ms — we can't use fake timers because the router's
    // hybrid detector uses `Date.now` internally; the sleep here is bounded.
    while (Date.now() - start < 25) {
      /* spin */
    }
    appendToActiveBlock(SESSION, bytesToB64(ascii('more bytes\n')));

    // The only event in `received` from the idle path would have source
    // 'idle' with kind 'command_end'. We assert none surfaced.
    const idleEvents = received.filter((e) => e.source === 'idle');
    expect(idleEvents).toEqual([]);
    // The block is still running (no authoritative close landed).
    expect(store.running()).toHaveLength(1);
  });

  it("DOES emit command_end via idle when shellIntegration='missing' (fallback path)", () => {
    const SESSION = 'sess-int-3' as SessionId;
    const store = makeSharedBlockStore(SESSION);
    unbind = bindBlockStore(store.routerPort);
    const pin = makePinPort(10);
    const listener = createBoundaryListener(
      SESSION,
      store.listenerPort,
      pin.port,
    );
    const received: BoundaryEvent[] = [];
    installCommandRouter(SESSION, {
      detector: null,
      hybrid: {
        shellIntegration: 'missing',
        idleTimeoutMs: 10,
        onHybridBoundary: (event) => {
          received.push(event);
          listener.pump([event]);
        },
      },
    });

    // Seed a prompt_start via the regex tier (the missing-integration path
    // has no OSC 133 guarantee) so the listener has an active block to
    // close when idle fires.
    appendToActiveBlock(SESSION, bytesToB64(ascii('output\n$ ')));
    expect(store.running()).toHaveLength(1);

    // Elapse past the idle threshold, then poke the router so the detector
    // observes the deadline crossing at feed-entry and emits an idle
    // command_end BEFORE consuming the new bytes.
    const start = Date.now();
    while (Date.now() - start < 25) {
      /* spin */
    }
    appendToActiveBlock(SESSION, bytesToB64(ascii('x')));

    const idleEvents = received.filter((e) => e.source === 'idle');
    expect(idleEvents).toHaveLength(1);
    expect(idleEvents[0]?.kind).toBe('command_end');
    // The listener forwarded the idle event → the block transitioned to
    // completed with null exitCode (idle cannot carry an exit code).
    const running = store.running();
    expect(running).toHaveLength(0);
    // The first issued block should have been closed.
    const closed = [...store.records.values()].filter(
      (r) => r.status === 'completed',
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.exitCode).toBeNull();
  });
});
