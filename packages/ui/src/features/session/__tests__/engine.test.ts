/**
 * Plan 0005 α1 — session-scoped VT engine wiring tests.
 *
 * These tests pin the contract documented in `docs/plans/0005-sota-convergence`:
 *
 *   - The engine is live from the moment `connectSession()` resolves.
 *   - Every `pty_data` byte reaches the engine BEFORE any other consumer.
 *   - Bytes fan out in parallel to the legacy block-router path (P0).
 *   - Subscribers receive grid envelopes (snapshot / delta / mode_changed).
 *   - Resize routes through both the engine grid and the bridge.
 *   - Dispose flushes pending batched bytes through the emulator.
 *
 * The tests use a manual rAF scheduler so the frame-skip batcher can be
 * driven deterministically; there is no sleeping, no jsdom timing sensitivity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
  SpawnSessionOptions,
  SpawnSessionResult,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';
import { connectSession } from '../connect.js';
import { createSessionEngine } from '../engine.js';
import { useSessionStore } from '../../../entities/session/index.js';
import { __resetRouterForTests } from '../../command/route-output.js';

interface ScriptedBridge extends HostBridge {
  emit: (event: HostEvent) => void;
  listenerCount: () => number;
  resizeCalls: Array<{ cols: number; rows: number }>;
}

function makeBridge(spawnResult: Partial<SpawnSessionResult> = {}): ScriptedBridge {
  const listeners = new Set<HostEventListener>();
  const resizeCalls: Array<{ cols: number; rows: number }> = [];
  const bridge: ScriptedBridge = {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
      return {
        sessionId: (spawnResult.sessionId ?? 'sess-α') as SessionId,
        shell: spawnResult.shell ?? '/bin/zsh',
        cwd: spawnResult.cwd ?? options.cwd ?? '/',
      };
    },
    async write() {},
    async resize(_id, cols, rows) {
      resizeCalls.push({ cols, rows });
    },
    async close() {},
    async cancelBlock() {},
    async notify() {},
    async openInEditor() {},
    async installShellIntegration() {
      return {
        targetPath: '/tmp/stub',
        snippet: '',
        alreadyInstalled: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async uninstallShellIntegration() {
      return {
        targetPath: '/tmp/stub',
        removedRegion: '',
        alreadyAbsent: true,
        fileMissing: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async aiSuggest() {
      return {
        id: 'stub',
        command: 'ls',
        tier: 'safe',
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    async readTextFile() {
      return null;
    },
    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    emit(event: HostEvent) {
      for (const l of listeners) l(event);
    },
    listenerCount: () => listeners.size,
    resizeCalls,
  };
  return bridge;
}

/** Encode a Uint8Array to base64 (matches the jsdom `btoa` path used in tests). */
function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function asciiB64(text: string): string {
  return toB64(new TextEncoder().encode(text));
}

describe('createSessionEngine (unit)', () => {
  it('allocates an emulator at the requested dimensions', () => {
    const engine = createSessionEngine({ sessionId: 'unit', cols: 80, rows: 24 });
    const dims = engine.emulator.getDimensions();
    expect(dims).toEqual({ rows: 24, cols: 80 });
    engine.dispose();
  });

  it('feed() routes bytes through the batcher into the emulator', () => {
    const batched: Uint8Array[] = [];
    // Manual scheduler so we can tick the rAF trampoline deterministically.
    const callbacks = new Map<number, () => void>();
    let nextId = 1;
    const tick = (): void => {
      const pending = Array.from(callbacks.entries());
      callbacks.clear();
      for (const [, cb] of pending) cb();
    };

    const engine = createSessionEngine({
      sessionId: 'unit',
      cols: 10,
      rows: 4,
      scheduler: (cb) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      cancelScheduler: (id) => {
        callbacks.delete(id);
      },
    });

    // Observe when feed reaches the emulator (by inspecting cells after tick).
    engine.feed(new TextEncoder().encode('hi'));
    // Batched: nothing written into the grid until rAF fires. The initial
    // blank cell has `grapheme === ''`, not a literal space.
    expect(engine.emulator._getCell(0, 0)?.grapheme).not.toBe('h');
    tick();
    expect(engine.emulator._getCell(0, 0)?.grapheme).toBe('h');
    expect(engine.emulator._getCell(0, 1)?.grapheme).toBe('i');
    // `batched` is unused but we keep it so a future spy pointed at the
    // write() sink is a one-line change.
    expect(batched).toHaveLength(0);

    engine.dispose();
  });

  it('dispose() flushes pending queued bytes through the emulator', () => {
    const callbacks = new Map<number, () => void>();
    let nextId = 1;
    const engine = createSessionEngine({
      sessionId: 'unit',
      cols: 10,
      rows: 4,
      scheduler: (cb) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      cancelScheduler: (id) => {
        callbacks.delete(id);
      },
    });

    engine.feed(new TextEncoder().encode('xy'));
    // Queued but not yet flushed.
    expect(engine.stats().queuedBytes).toBe(2);

    engine.dispose();

    // After dispose, queue is drained and emulator has the bytes.
    expect(engine.stats().queuedBytes).toBe(0);
    expect(engine.emulator._getCell(0, 0)?.grapheme).toBe('x');
    expect(engine.emulator._getCell(0, 1)?.grapheme).toBe('y');
  });

  it('subscribe() fans out grid envelopes to multiple listeners', () => {
    const callbacks = new Map<number, () => void>();
    let nextId = 1;
    const engine = createSessionEngine({
      sessionId: 'unit',
      cols: 10,
      rows: 4,
      scheduler: (cb) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      cancelScheduler: (id) => {
        callbacks.delete(id);
      },
    });

    const envelopesA: string[] = [];
    const envelopesB: string[] = [];
    const unsubA = engine.subscribe((env) => envelopesA.push(env.payload.kind));
    const unsubB = engine.subscribe((env) => envelopesB.push(env.payload.kind));

    engine.feed(new TextEncoder().encode('ab'));
    // Tick rAF so the batcher actually writes.
    const pending = Array.from(callbacks.values());
    callbacks.clear();
    for (const cb of pending) cb();

    // At least one delta envelope from the write.
    expect(envelopesA.length).toBeGreaterThan(0);
    expect(envelopesB.length).toBe(envelopesA.length);
    expect(envelopesA).toEqual(envelopesB);

    unsubA();
    unsubB();
    engine.dispose();
  });

  it('subscribe() emits a mode_changed envelope on CSI ?1049h', () => {
    const callbacks = new Map<number, () => void>();
    let nextId = 1;
    const engine = createSessionEngine({
      sessionId: 'unit',
      cols: 10,
      rows: 4,
      scheduler: (cb) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      cancelScheduler: (id) => {
        callbacks.delete(id);
      },
    });

    const modeEvents: Array<{ alt_screen?: boolean }> = [];
    engine.subscribe((env) => {
      if (env.payload.kind === 'mode_changed') {
        for (const ch of env.payload.changes) {
          if (ch.mode === 'alt_screen') {
            modeEvents.push({ alt_screen: ch.value });
          }
        }
      }
    });

    engine.feed(new TextEncoder().encode('\x1b[?1049h'));
    const pending = Array.from(callbacks.values());
    callbacks.clear();
    for (const cb of pending) cb();

    expect(modeEvents.length).toBeGreaterThan(0);
    expect(modeEvents[0]!.alt_screen).toBe(true);

    engine.dispose();
  });

  it('resize() updates the emulator grid dimensions', () => {
    const engine = createSessionEngine({ sessionId: 'unit', cols: 80, rows: 24 });
    engine.resize(100, 40);
    const dims = engine.emulator.getDimensions();
    expect(dims).toEqual({ rows: 40, cols: 100 });
    engine.dispose();
  });

  it('multi-byte UTF-8 split across chunks decodes correctly', () => {
    const callbacks = new Map<number, () => void>();
    let nextId = 1;
    const engine = createSessionEngine({
      sessionId: 'unit',
      cols: 10,
      rows: 4,
      scheduler: (cb) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      cancelScheduler: (id) => {
        callbacks.delete(id);
      },
    });

    // U+4E2D '中' encodes as E4 B8 AD. Split across three chunks.
    engine.feed(new Uint8Array([0xe4]));
    engine.feed(new Uint8Array([0xb8]));
    engine.feed(new Uint8Array([0xad]));
    // Tick until queue drains (frame-skip may schedule multiple flushes).
    for (let i = 0; i < 4 && callbacks.size > 0; i += 1) {
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      for (const cb of pending) cb();
    }

    // Cell 0,0 now holds the full grapheme.
    expect(engine.emulator._getCell(0, 0)?.grapheme).toBe('中');

    engine.dispose();
  });
});

describe('connectSession — engine wiring (α1)', () => {
  beforeEach(() => {
    __resetRouterForTests();
    useSessionStore.getState().reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes an engine on ConnectedSession after connect resolves', async () => {
    const bridge = makeBridge();
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    expect(conn.engine).toBeDefined();
    expect(conn.engine.emulator.getDimensions()).toEqual({ rows: 24, cols: 80 });
    await conn.close();
  });

  it('feeds pty_data bytes into the engine (engine is SSOT for grid)', async () => {
    const bridge = makeBridge();
    const conn = await connectSession({
      bridge,
      cols: 10,
      rows: 4,
      onData: () => {},
    });

    bridge.emit({
      kind: 'pty_data',
      sessionId: 'sess-α' as SessionId,
      seq: 0,
      bytesB64: asciiB64('hi'),
    });

    // The connect path uses the real (rAF) scheduler; flushing via dispose is
    // the deterministic way to observe the emulator state in tests. Dispose
    // drains the queue through `flush()` before halting the batcher.
    conn.engine.dispose();
    expect(conn.engine.emulator._getCell(0, 0)?.grapheme).toBe('h');
    expect(conn.engine.emulator._getCell(0, 1)?.grapheme).toBe('i');

    await conn.close();
  });

  it('fans bytes to BOTH the engine AND the legacy onData callback', async () => {
    const bridge = makeBridge();
    const onData = vi.fn();
    const conn = await connectSession({
      bridge,
      cols: 10,
      rows: 4,
      onData,
    });

    const payload = asciiB64('ok');
    bridge.emit({
      kind: 'pty_data',
      sessionId: 'sess-α' as SessionId,
      seq: 0,
      bytesB64: payload,
    });

    // Legacy path: base64 forwarded verbatim.
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith(payload);

    // Engine path: decoded bytes reached the emulator after drain.
    conn.engine.dispose();
    expect(conn.engine.emulator._getCell(0, 0)?.grapheme).toBe('o');
    expect(conn.engine.emulator._getCell(0, 1)?.grapheme).toBe('k');

    await conn.close();
  });

  it('resize() updates the engine grid in addition to the bridge', async () => {
    const bridge = makeBridge();
    const conn = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => {},
    });

    await conn.resize(100, 50);

    expect(conn.engine.emulator.getDimensions()).toEqual({ rows: 50, cols: 100 });
    expect(bridge.resizeCalls).toEqual([{ cols: 100, rows: 50 }]);

    await conn.close();
  });

  it('close() disposes the engine (stats().queuedBytes drains to 0)', async () => {
    const bridge = makeBridge();
    const conn = await connectSession({
      bridge,
      cols: 10,
      rows: 4,
      onData: () => {},
    });

    // Enqueue bytes but close without waiting for rAF.
    bridge.emit({
      kind: 'pty_data',
      sessionId: 'sess-α' as SessionId,
      seq: 0,
      bytesB64: asciiB64('flush'),
    });

    await conn.close();

    // After close, dispose has run — queue drained, bytes visible in grid.
    expect(conn.engine.stats().queuedBytes).toBe(0);
    expect(conn.engine.emulator._getCell(0, 0)?.grapheme).toBe('f');
  });

  it('an engine subscriber receives at least one grid envelope for a feed', async () => {
    const bridge = makeBridge();
    const conn = await connectSession({
      bridge,
      cols: 10,
      rows: 4,
      onData: () => {},
    });

    const kinds: string[] = [];
    const unsub = conn.engine.subscribe((env) => kinds.push(env.payload.kind));

    bridge.emit({
      kind: 'pty_data',
      sessionId: 'sess-α' as SessionId,
      seq: 0,
      bytesB64: asciiB64('x'),
    });
    // Drain the batcher to deliver the envelope synchronously.
    conn.engine.dispose();

    expect(kinds.length).toBeGreaterThan(0);
    // The first delta emission for a feed containing printable bytes is a
    // grid_delta (snapshot is only emitted on construction / resize / reset).
    expect(kinds).toContain('grid_delta');

    unsub();
    await conn.close();
  });
});
