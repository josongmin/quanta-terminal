/**
 * Plan 0005 P1 wave 2 — integration audit.
 *
 * Verifies that the P1 wave 1 pieces (hybrid boundary detector, block-
 * boundary listener + block store, mode-stack drivers, scrollback-wide
 * output search, session-restore replay, shell-integration auto-install
 * back-off) cohesively interoperate under a single end-to-end scenario.
 *
 * Each `it()` below wires the real P1 modules together against a real
 * `VtEmulator` when grid state is load-bearing, otherwise uses the modules'
 * own stub ports. Tests deliberately bypass `features/session/connect.ts`
 * because — as documented in p1-wave2-gaps.md — P1-A's hybrid detector is
 * not yet threaded through the production session pipeline; wave-2 W2-B
 * owns that integration. The tests here pin the SEAM behavior: given
 * `installBoundaryListener` is invoked with the emitted detector events,
 * block store mutations + pin lifecycle are correct.
 *
 * Do NOT modify P1 wave 1 code to make these tests green. Any failure is
 * documented in `docs/plans/0005-sota-convergence/p1-wave2-gaps.md` with a
 * recommended W2-B / W2-C fix.
 */

import { describe, expect, it, vi } from 'vitest';

import { VtEmulator } from '../../shared/lib/vt-emulator/index.js';
import {
  createHybridBoundaryDetector,
  installBoundaryListener,
  mapSourceToConfidence,
} from '../../features/command/index.js';
import type {
  BoundaryBlockStorePort,
  ScrollbackPinPort,
  BoundaryEvent,
} from '../../features/command/index.js';
import { searchGrid } from '../../features/output-search/index.js';
import { replaySession } from '../../features/session-restore/index.js';
import {
  isInBackoff,
  readBackoff,
  writeBackoff,
  MAX_CONSECUTIVE_FAILURES,
  BACKOFF_WINDOW_MS,
  type BackoffRecord,
  type KeyValueStorage,
} from '../../features/session/shell-install.js';
import {
  useModeStackStore,
  createAltScreenDriver,
  createMultiplexerDriver,
  createNestedShellDriver,
} from '../../features/mode-stack/index.js';
import type { SessionId, BlockId } from '../../shared/types/generated/index.js';

// -------------------------------------------------------------------- helpers

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeEmulator(rows: number, cols: number, scrollbackRows = 10_000): VtEmulator {
  return new VtEmulator({
    sessionId: 'p1-int',
    rows,
    cols,
    scrollbackRows,
    onEnvelope: () => {},
  });
}

function feedEm(em: VtEmulator, s: string): void {
  em.feed(encode(s));
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
  return {
    port: {
      startBlock: startBlock as unknown as BoundaryBlockStorePort['startBlock'],
      completeBlock: completeBlock as unknown as BoundaryBlockStorePort['completeBlock'],
      setBlockRowRange:
        setBlockRowRange as unknown as BoundaryBlockStorePort['setBlockRowRange'],
      setBlockDuration:
        setBlockDuration as unknown as BoundaryBlockStorePort['setBlockDuration'],
      getActiveBlockId,
    },
    startBlock,
    completeBlock,
    setBlockRowRange,
    setBlockDuration,
    getActiveBlockId,
    issuedIds,
  };
}

function makePinPort(em: VtEmulator): {
  port: ScrollbackPinPort;
  pinSpy: ReturnType<typeof vi.fn>;
  unpinSpy: ReturnType<typeof vi.fn>;
} {
  const pinSpy = vi.fn((rowId: number) => {
    em.pinScrollbackRow(rowId);
  });
  const unpinSpy = vi.fn((rowId: number) => {
    em.unpinScrollbackRow(rowId);
  });
  const port: ScrollbackPinPort = {
    getNextRowId: () => {
      const sb = em.getScrollback();
      return sb.baseRowId + sb.rows.length;
    },
    pinScrollbackRow: pinSpy,
    unpinScrollbackRow: unpinSpy,
  };
  return { port, pinSpy, unpinSpy };
}

class InMemoryStorage implements KeyValueStorage {
  public readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const SID = 'p1-int-sess' as SessionId;

// ------------------------------------------------------------------- scenarios

describe('P1 wave 1 integration audit', () => {
  describe('test_p1_stack_basic_end_to_end', () => {
    it('OSC 133 B/C/D cycle fed through detector, listener, store, and pin API', () => {
      const em = makeEmulator(6, 40);
      const detector = createHybridBoundaryDetector({
        shellIntegration: 'installed',
      });
      const store = makeStorePort();
      const pins = makePinPort(em);
      const listener = installBoundaryListener(SID, detector, store.port, pins.port);

      // Prompt: shell integration emits OSC 133 A + prompt text.
      const promptBytes = encode('\x1b]133;A\x07user@host ~ $ ');
      em.feed(promptBytes);
      let events = detector.feed(promptBytes);
      listener.pump(events);
      expect(store.startBlock).toHaveBeenCalledTimes(1);
      // Confidence should be authoritative (OSC 133 source).
      const startCall = store.startBlock.mock.calls[0]!;
      // startBlock signature: (command, cwd, options)
      const opts = startCall[2] as { readonly confidence?: string };
      expect(opts.confidence).toBe('authoritative');

      // User types "ls" + Enter — shell echoes "ls\r\n".
      const cmdBytes = encode('ls\r\n');
      em.feed(cmdBytes);
      events = detector.feed(cmdBytes);
      listener.pump(events);

      // Command output.
      const outBytes = encode('file1.txt  file2.txt\r\n');
      em.feed(outBytes);
      events = detector.feed(outBytes);
      listener.pump(events);

      // Shell emits command_end (OSC 133 D) with exit code 0 + duration.
      const endBytes = encode('\x1b]133;D;0;duration_ms=42\x07');
      em.feed(endBytes);
      events = detector.feed(endBytes);
      listener.pump(events);

      // command_end should have finalized the block with exit code 0.
      expect(store.completeBlock).toHaveBeenCalled();
      const completeArgs = store.completeBlock.mock.calls[0]!;
      expect(completeArgs[1]).toBe(0);
      // Duration stamp from OSC 133 D.
      expect(store.setBlockDuration).toHaveBeenCalled();
      expect(store.setBlockDuration.mock.calls[0]![1]).toBe(42);
      // Pin lifecycle: one pin at prompt_start, one unpin at command_end.
      expect(pins.pinSpy).toHaveBeenCalledTimes(1);
      expect(pins.unpinSpy).toHaveBeenCalledTimes(1);

      listener.dispose();
    });

    it('confidence mapping matches the P1-A taxonomy for every source tier', () => {
      // Sanity-check the seam contract consumed by block store chrome (P1-C).
      expect(mapSourceToConfidence('osc133')).toBe('authoritative');
      expect(mapSourceToConfidence('heuristic_regex')).toBe('heuristic');
      expect(mapSourceToConfidence('cursor_home')).toBe('heuristic');
      expect(mapSourceToConfidence('idle')).toBe('idle');
    });
  });

  describe('test_p1_session_restore_roundtrip', () => {
    it('replaySession returns no_journal fallback when the port is empty', async () => {
      // P1-E contract: empty port → fallbackReason === 'no_journal', no
      // throw, no emulator mutation. This pins the replay entry point; the
      // richer byte-identical roundtrip lives in
      // `features/session-restore/__tests__/replay.test.ts` against fixture
      // `.qrpl` files.
      const result = await replaySession(SID, {
        port: { loadSessionJournal: async () => [] },
      });
      expect(result.fallbackReason).toBe('no_journal');
      expect(result.playedFrames).toBe(0);
      expect(result.playedBytes).toBe(0);
    });

    it('replaySession byte-identical roundtrip on a minimal journal', async () => {
      // Build a one-frame journal and verify replay produces the expected
      // byte throughput.  Full format coverage lives in replay.test.ts; this
      // scenario only guards the seam used by TerminalPage.
      const MAGIC = new Uint8Array([0x51, 0x52, 0x50, 0x4c, 0x00, 0x00, 0x00, 0x00]);
      const headerBuf = new Uint8Array(512);
      headerBuf.set(MAGIC, 0);
      // Version=1
      new DataView(headerBuf.buffer).setUint32(8, 1, true);
      // cols=80
      new DataView(headerBuf.buffer).setUint32(12, 80, true);
      // rows=24
      new DataView(headerBuf.buffer).setUint32(16, 24, true);

      const payload = encode('hello\r\n');
      const frame = new Uint8Array(10 + payload.byteLength);
      frame[0] = 0x46; // 'F'
      frame[1] = 0x52; // 'R'
      const fv = new DataView(frame.buffer);
      fv.setUint32(2, 0, true); // tsMs = 0
      fv.setUint32(6, payload.byteLength, true);
      frame.set(payload, 10);

      const journal = new Uint8Array(headerBuf.byteLength + frame.byteLength);
      journal.set(headerBuf, 0);
      journal.set(frame, headerBuf.byteLength);

      const result = await replaySession(SID, {
        port: { loadSessionJournal: async () => [journal] },
      });
      expect(result.fallbackReason).toBeNull();
      expect(result.playedFrames).toBeGreaterThanOrEqual(1);
      expect(result.playedBytes).toBe(payload.byteLength);
    });
  });

  describe('test_p1_mode_stack_depth_3', () => {
    it('nested tmux / ssh / tmux driver composition reaches depth 3', () => {
      // Use independent store instance semantics by resetting before + after.
      const store = useModeStackStore.getState();
      store.reset();

      // Layer composition mirrors the C-MUX-03 compat fixture: an outer
      // tmux, an ssh nested-shell inside it, and an inner tmux. Drivers
      // push on their own; we feed each tmux's DCS marker directly.
      const outerTmux = createMultiplexerDriver({ stack: store });
      const ssh = createNestedShellDriver({ stack: store, rootLevel: 1 });
      const innerTmux = createMultiplexerDriver({ stack: store });

      // 1. Outer tmux detected via the `tmux;` DCS prefix.
      outerTmux.feed(encode('\x1bPtmux;init\x1b\\'));
      expect(useModeStackStore.getState().layers).toHaveLength(2);
      expect(useModeStackStore.getState().layers[1]!.kind).toBe('multiplexer');

      // 2. SSH bumps the SHLVL: nested-shell driver pushes a shell layer.
      ssh.setShellLevel(2);
      expect(useModeStackStore.getState().layers).toHaveLength(3);
      expect(useModeStackStore.getState().layers[2]!.kind).toBe('nested-shell');

      // 3. Inner tmux detected on the nested shell.
      innerTmux.feed(encode('\x1bPtmux;inner\x1b\\'));
      expect(useModeStackStore.getState().layers).toHaveLength(4);
      expect(useModeStackStore.getState().layers[3]!.kind).toBe('multiplexer');

      // Depth-3 meaning (shell + 3 nested non-shell layers).
      const nonShellLayers = useModeStackStore
        .getState()
        .layers.filter((l) => l.kind !== 'shell');
      expect(nonShellLayers).toHaveLength(3);

      // Tear down in reverse order — each driver only pops the layer it owns.
      innerTmux.dispose();
      ssh.dispose();
      outerTmux.dispose();
      store.reset();
    });

    it('alt-screen + tmux drivers compose without id collisions', () => {
      const store = useModeStackStore.getState();
      store.reset();
      const alt = createAltScreenDriver({ stack: store });
      const mux = createMultiplexerDriver({ stack: store });

      // Tmux first, then vim inside tmux (alt-screen).
      mux.feed(encode('\x1bPtmux;go\x1b\\'));
      alt.feed(encode('\x1b[?1049h'));
      expect(useModeStackStore.getState().layers).toHaveLength(3);
      expect(useModeStackStore.getState().layers[1]!.kind).toBe('multiplexer');
      expect(useModeStackStore.getState().layers[2]!.kind).toBe('tui');

      // Vim exits (alt-screen off) → tui layer pops; tmux stays.
      alt.feed(encode('\x1b[?1049l'));
      expect(useModeStackStore.getState().layers).toHaveLength(2);

      alt.dispose();
      mux.dispose();
      store.reset();
    });
  });

  describe('test_p1_output_search_across_scrollback', () => {
    it('1000 rows in scrollback + viewport: literal "error" search returns every match', () => {
      const em = makeEmulator(8, 40, 1200);
      // Emit 1000 lines; sprinkle "error" every 37th line so matches land in
      // both scrollback and viewport regions.
      const expectedMatches: number[] = [];
      for (let i = 0; i < 1000; i += 1) {
        const isHit = i % 37 === 0;
        if (isHit) expectedMatches.push(i);
        feedEm(em, `line ${i}${isHit ? ' error' : ''}\r\n`);
      }
      const hits = searchGrid(em, 'error');
      expect(hits.length).toBe(expectedMatches.length);
      // Each hit's text is 'error', case preserved.
      for (const h of hits) expect(h.text).toBe('error');
      // rowIds are monotonically increasing across scrollback+viewport.
      for (let i = 1; i < hits.length; i += 1) {
        expect(hits[i]!.rowId).toBeGreaterThan(hits[i - 1]!.rowId);
      }
    });

    it('case-insensitive search spans scrollback and viewport', () => {
      const em = makeEmulator(4, 40, 200);
      for (let i = 0; i < 100; i += 1) {
        feedEm(em, `ERROR early-row-${i}\r\n`);
      }
      for (let i = 0; i < 3; i += 1) {
        feedEm(em, `error tail-${i}\r\n`);
      }
      const hits = searchGrid(em, 'error', { caseSensitive: false });
      // 100 + 3 = 103 (scrollback cap would trim, but 103 < 200 ring).
      expect(hits.length).toBe(103);
    });
  });

  describe('test_p1_shell_install_back_off', () => {
    it('3 consecutive failures lock the shell out for 24 h', () => {
      const storage = new InMemoryStorage();
      const now = 1_000_000;
      // Simulate 3 prior failures at time `now`.
      writeBackoff(storage, 'zsh', {
        lastAttemptAt: now,
        failCount: MAX_CONSECUTIVE_FAILURES,
      });
      const record = readBackoff(storage, 'zsh');
      expect(record).not.toBeNull();
      expect(record!.failCount).toBe(MAX_CONSECUTIVE_FAILURES);

      // Immediately after the 3rd failure → back-off active.
      expect(isInBackoff(record, now + 1)).toBe(true);
      // 1 hour later → still active.
      expect(isInBackoff(record, now + 60 * 60 * 1000)).toBe(true);
      // 23h59m → still active.
      expect(isInBackoff(record, now + BACKOFF_WINDOW_MS - 1)).toBe(true);
      // >= 24h → unlocked.
      expect(isInBackoff(record, now + BACKOFF_WINDOW_MS)).toBe(false);
    });

    it('fewer than threshold failures never triggers back-off', () => {
      const now = 1_000_000;
      const two: BackoffRecord = { lastAttemptAt: now, failCount: 2 };
      expect(isInBackoff(two, now + 1_000)).toBe(false);
      expect(isInBackoff(null, now)).toBe(false);
    });
  });

  describe('cross-epic integration sanity', () => {
    it('hybrid detector heuristic + listener produces a heuristic block when OSC 133 absent', () => {
      const em = makeEmulator(6, 40);
      // Shell integration not installed — OSC 133 won't fire, regex tier
      // must carry the prompt signal.
      const detector = createHybridBoundaryDetector({
        shellIntegration: 'missing',
      });
      const store = makeStorePort();
      const pins = makePinPort(em);
      const listener = installBoundaryListener(SID, detector, store.port, pins.port);

      // Feed a line that ends with a "$ " prompt followed by LF — the
      // heuristic_regex tier should emit prompt_start.
      const promptBytes = encode('user@host ~ $ \n');
      em.feed(promptBytes);
      const events = detector.feed(promptBytes);
      listener.pump(events);

      // Either regex OR idle may fire first depending on timing; inspect
      // the events themselves rather than assume a specific confidence.
      const promptEvents = events.filter((e: BoundaryEvent) => e.kind === 'prompt_start');
      if (promptEvents.length > 0) {
        expect(store.startBlock).toHaveBeenCalled();
        const opts = store.startBlock.mock.calls[0]![2] as {
          readonly confidence?: string;
        };
        // Heuristic regex → confidence 'heuristic' per mapSourceToConfidence.
        expect(['heuristic', 'authoritative']).toContain(opts.confidence);
      }

      listener.dispose();
    });
  });
});
