/**
 * SOTA unit coverage for `features/command/route-output.ts`.
 *
 * This file complements the pre-existing `route-output-multi-session.test.ts`
 * sibling by exercising the full public surface of the router module:
 * install / dispose lifecycle, boundary detection (including the cross-chunk
 * partial-terminator case), raw-chunk observers, finalize semantics on
 * pty_exit, multi-session pointer hygiene, and the test-only helpers.
 *
 * Design notes
 * ------------
 * - The router binds to `entities/block` through a named port. Tests never
 *   touch the real Zustand store; instead they install a hand-rolled
 *   `BlockStoreActions` recorder through `bindBlockStore()`. The recorder
 *   is a stateful fake, not a mock — we read `getActiveBlockId()` back to
 *   assert pointer hygiene, and record calls for assertion.
 * - `__resetRouterForTests()` is the single source of truth for test reset.
 *   We call it in both beforeEach AND afterEach so a failing test cannot
 *   leak router state (per-session handles, raw observers, lookup port,
 *   store active pointer) into the next one.
 * - The mock boundary terminator is `MOCK_PROMPT_BYTES` (11 bytes:
 *   ESC [36m $ ESC [0m SPACE). Base64 fixtures below were precomputed so
 *   they match exactly what the mock bridge would emit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockId, SessionId } from '../../../shared/types/generated/index.js';
import {
  __resetRouterForTests,
  __resetRawObserversForTests,
  __emitRawChunkForTests,
  addRouterRawObserver,
  appendToActiveBlock,
  finalizeActiveBlock,
  getActiveBlockId,
  IDLE_COMPLETE_MS,
  installCommandRouter,
  isCommandRouterInstalled,
  setRouterBlockSessionLookup,
} from '../route-output.js';
import { createMockBoundaryDetector } from '../boundary-detector.js';
import { bindBlockStore, type BlockStoreActions } from '../block-store-port.js';

// ----- Test fixtures: precomputed base64 for mock-terminator scenarios -----

/** "foo" — 3 plain bytes, no terminator. */
const B64_FOO = 'Zm9v';
/** "bar" — 3 plain bytes, no terminator. */
const B64_BAR = 'YmFy';
/** "hello" + full MOCK_PROMPT_BYTES terminator, in one chunk. */
const B64_HELLO_TERM = 'aGVsbG8bWzM2bSQbWzBtIA==';
/** "hello" + first 5 bytes of terminator (ESC [ 3 6 m). Exercises cross-chunk carry. */
const B64_HELLO_PARTIAL_TERM = 'aGVsbG8bWzM2bQ==';
/** The rest of the terminator: $ ESC [ 0 m SPACE. Completes the match on feed #2. */
const B64_TERM_REST = 'JBtbMG0g';
/** "hello" + terminator + "ignored" trailing — checks bytes-after-terminator are dropped. */
const B64_HELLO_TERM_TRAIL = 'aGVsbG8bWzM2bSQbWzBtIGlnbm9yZWQ=';

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

// ----- Recorder: stateful fake BlockStoreActions -----

interface Recorder {
  readonly store: BlockStoreActions;
  readonly appends: Array<{ id: BlockId; bytes: Uint8Array }>;
  readonly completes: Array<{ id: BlockId; exitCode: number | null }>;
  readonly cancels: BlockId[];
  readonly errors: Array<{ id: BlockId; message: string }>;
  setActive: (id: BlockId | null) => void;
  setRunning: (ids: readonly BlockId[]) => void;
  bindBlockToSession: (id: BlockId, session: SessionId) => void;
  lookup: (id: BlockId) => SessionId | undefined;
}

function makeRecorder(): Recorder {
  let active: BlockId | null = null;
  let running: readonly BlockId[] = [];
  const blockToSession = new Map<BlockId, SessionId>();
  const appends: Array<{ id: BlockId; bytes: Uint8Array }> = [];
  const completes: Array<{ id: BlockId; exitCode: number | null }> = [];
  const cancels: BlockId[] = [];
  const errors: Array<{ id: BlockId; message: string }> = [];

  const store: BlockStoreActions = {
    createBlock: vi.fn(() => 'blk-created' as BlockId),
    startBlock: vi.fn(() => 'blk-started' as BlockId),
    setActiveBlockId: (id) => {
      active = id;
    },
    getActiveBlockId: () => active,
    appendBlockOutput: (id, chunk) => {
      appends.push({ id, bytes: new Uint8Array(chunk) });
    },
    completeBlock: (id, exitCode) => {
      completes.push({ id, exitCode });
      if (active === id) active = null;
    },
    cancelBlock: (id) => {
      cancels.push(id);
      if (active === id) active = null;
    },
    errorBlock: (id, message) => {
      errors.push({ id, message });
    },
    getRunningBlockIds: () => running,
  };

  return {
    store,
    appends,
    completes,
    cancels,
    errors,
    setActive: (id) => {
      active = id;
    },
    setRunning: (ids) => {
      running = ids;
    },
    bindBlockToSession: (id, session) => {
      blockToSession.set(id, session);
    },
    lookup: (id) => blockToSession.get(id),
  };
}

// ----- Suite-wide setup / teardown -----

let unbindStore: (() => void) | undefined;

beforeEach(() => {
  __resetRouterForTests();
  __resetRawObserversForTests();
});

afterEach(() => {
  if (unbindStore) unbindStore();
  unbindStore = undefined;
  __resetRouterForTests();
  __resetRawObserversForTests();
  setRouterBlockSessionLookup(null);
  vi.restoreAllMocks();
});

// =====================================================================
// A. Install / dispose lifecycle
// =====================================================================

describe('installCommandRouter — install & dispose lifecycle', () => {
  it('marks the session as installed after install', () => {
    const A = 'sess-a' as SessionId;
    expect(isCommandRouterInstalled(A)).toBe(false);
    installCommandRouter(A);
    expect(isCommandRouterInstalled(A)).toBe(true);
  });

  it('dispose() removes the install flag for that session', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    const handle = installCommandRouter(A);
    expect(isCommandRouterInstalled(A)).toBe(true);
    handle.dispose();
    expect(isCommandRouterInstalled(A)).toBe(false);
  });

  it('two concurrent sessions remain independently installed', () => {
    const A = 'sess-a' as SessionId;
    const B = 'sess-b' as SessionId;
    const ra = installCommandRouter(A);
    installCommandRouter(B);

    expect(isCommandRouterInstalled(A)).toBe(true);
    expect(isCommandRouterInstalled(B)).toBe(true);

    ra.dispose();
    expect(isCommandRouterInstalled(A)).toBe(false);
    expect(isCommandRouterInstalled(B)).toBe(true);
  });

  it('re-install on same session id replaces the detector without leaking', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const first = installCommandRouter(A);

    // Seed a carry: feed partial terminator through `first`.
    rec.bindBlockToSession('blk-a' as BlockId, A);
    rec.setActive('blk-a' as BlockId);
    appendToActiveBlock(A, B64_HELLO_PARTIAL_TERM);
    // After a partial-terminator feed, carry is held in `first`'s detector.
    // With no boundary yet, "hello" went downstream but 5 bytes of terminator
    // are carried inside the detector.
    expect(rec.appends.length).toBeGreaterThanOrEqual(1);

    const appendsBefore = rec.appends.length;

    // Install again — the new handle replaces the detector. The second half
    // of the terminator alone must NOT complete the boundary (because the
    // carry was blown away), i.e. those 6 bytes land as raw output.
    installCommandRouter(A);
    appendToActiveBlock(A, B64_TERM_REST);
    // No boundary → no completeBlock call.
    expect(rec.completes).toHaveLength(0);
    // Those 6 bytes should have been forwarded as output on the new detector.
    expect(rec.appends.length).toBeGreaterThan(appendsBefore);

    // The stale `first` handle must NOT delete the live router on dispose.
    first.dispose();
    expect(isCommandRouterInstalled(A)).toBe(true);
  });

  it('dispose() on a stale handle is a no-op', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const first = installCommandRouter(A);
    installCommandRouter(A); // replaces `first` silently

    rec.bindBlockToSession('blk-a' as BlockId, A);
    rec.setActive('blk-a' as BlockId);

    first.dispose();

    // Active pointer untouched (stale handle defers to the live one).
    expect(rec.store.getActiveBlockId()).toBe('blk-a');
    // Router still installed under A.
    expect(isCommandRouterInstalled(A)).toBe(true);
  });
});

// =====================================================================
// B. appendToActiveBlock — baseline paths
// =====================================================================

describe('appendToActiveBlock — baseline routing paths', () => {
  it('is a silent no-op when no router is installed for the session', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    rec.setActive('blk-nope' as BlockId);

    appendToActiveBlock('sess-ghost' as SessionId, B64_FOO);
    expect(rec.appends).toHaveLength(0);
  });

  it('is a silent no-op when the block store is not bound', () => {
    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    // Deliberately do NOT bindBlockStore — emulates pre-bootstrap ordering.
    expect(() => appendToActiveBlock(A, B64_FOO)).not.toThrow();
  });

  it('drops the chunk when no block is active (shell greeting case)', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    // active stays null.
    appendToActiveBlock(A, B64_FOO);
    expect(rec.appends).toHaveLength(0);
    expect(rec.completes).toHaveLength(0);
  });

  it('normal path: bytes without a terminator flow to appendBlockOutput on the active block', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_FOO);
    expect(rec.appends).toHaveLength(1);
    expect(rec.appends[0]?.id).toBe('blk-a');
    expect(bytesToText(rec.appends[0]!.bytes)).toBe('foo');
    expect(rec.completes).toHaveLength(0);
  });

  it('delivers bytes to the currently-active block even after the active pointer changes mid-stream', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-1' as BlockId);
    appendToActiveBlock(A, B64_FOO);

    rec.setActive('blk-2' as BlockId);
    appendToActiveBlock(A, B64_BAR);

    expect(rec.appends).toHaveLength(2);
    expect(rec.appends[0]?.id).toBe('blk-1');
    expect(rec.appends[1]?.id).toBe('blk-2');
  });

  it('re-exports getActiveBlockId and it reflects the bound store', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    rec.setActive('blk-x' as BlockId);
    expect(getActiveBlockId()).toBe('blk-x');
  });
});

// =====================================================================
// C. Boundary detection
// =====================================================================

describe('appendToActiveBlock — boundary detection', () => {
  it('full-terminator chunk: preBoundary bytes appended, completeBlock called with exitCode 0', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_HELLO_TERM);

    expect(rec.appends).toHaveLength(1);
    expect(bytesToText(rec.appends[0]!.bytes)).toBe('hello');
    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 0 }]);
  });

  it('bytes after the terminator are discarded (no second block is active yet)', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_HELLO_TERM_TRAIL);

    // Pre-boundary = "hello"; the mock terminator closes the block; the
    // "ignored" bytes past the terminator are dropped because there is no
    // follow-up active block to receive them.
    expect(rec.appends).toHaveLength(1);
    expect(bytesToText(rec.appends[0]!.bytes)).toBe('hello');
    expect(rec.completes).toHaveLength(1);
  });

  it('partial-terminator split across chunks: boundary resolves on the second feed', () => {
    // This is the "treacherous" case — a naive stateless suffix-match would
    // miss the cross-chunk terminator and leak the next block's leading
    // bytes into the closing block. The stateful detector must hold carry.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_HELLO_PARTIAL_TERM);
    // First feed: "hello" forwarded; last 5 bytes (start of terminator)
    // carried internally as pending match.
    expect(rec.completes).toHaveLength(0);
    // We assert the visible bytes so far concatenate to "hello".
    const soFar = rec.appends.map((a) => bytesToText(a.bytes)).join('');
    expect(soFar).toBe('hello');

    appendToActiveBlock(A, B64_TERM_REST);
    // Second feed completes the terminator → block closes. No extra bytes
    // (the second chunk was entirely terminator tail).
    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 0 }]);
    const finalText = rec.appends.map((a) => bytesToText(a.bytes)).join('');
    expect(finalText).toBe('hello');
  });

  it('detector is replaced on boundary — carry from the prior block does NOT leak', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    // Close block A with full terminator.
    appendToActiveBlock(A, B64_HELLO_TERM);
    expect(rec.completes).toHaveLength(1);

    // Start a new block and feed only the back-half of a terminator. The
    // new detector must NOT treat the stale carry as a match — these 6
    // bytes should just land as output.
    rec.setActive('blk-b' as BlockId);
    appendToActiveBlock(A, B64_TERM_REST);

    expect(rec.completes).toHaveLength(1); // still just the first close
    // The new block received the 6 bytes as plain output.
    const forBlkB = rec.appends.filter((a) => a.id === 'blk-b');
    expect(forBlkB.length).toBe(1);
    expect(forBlkB[0]!.bytes.length).toBe(6);
  });

  it('empty chunk (empty base64) is a no-op when active', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, '');
    // Empty chunk → detector emits empty preBoundary → no appendBlockOutput
    // (router guards with preBoundary.length > 0).
    expect(rec.appends).toHaveLength(0);
    expect(rec.completes).toHaveLength(0);
  });
});

// =====================================================================
// D. Raw chunk observers (side-channel)
// =====================================================================

describe('raw chunk observers', () => {
  it('addRouterRawObserver fires on each append', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    const seen: Uint8Array[] = [];
    addRouterRawObserver((c) => seen.push(new Uint8Array(c)));

    appendToActiveBlock(A, B64_FOO);
    appendToActiveBlock(A, B64_BAR);

    expect(seen).toHaveLength(2);
    expect(bytesToText(seen[0]!)).toBe('foo');
    expect(bytesToText(seen[1]!)).toBe('bar');
  });

  it('returned unsubscribe stops delivery', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    const seen: Uint8Array[] = [];
    const off = addRouterRawObserver((c) => seen.push(new Uint8Array(c)));

    appendToActiveBlock(A, B64_FOO);
    off();
    appendToActiveBlock(A, B64_BAR);

    expect(seen).toHaveLength(1);
    expect(bytesToText(seen[0]!)).toBe('foo');
  });

  it('multiple observers all fire in insertion order', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    const order: string[] = [];
    addRouterRawObserver(() => order.push('one'));
    addRouterRawObserver(() => order.push('two'));
    addRouterRawObserver(() => order.push('three'));

    appendToActiveBlock(A, B64_FOO);

    // Set iteration order is insertion order in modern JS engines, and the
    // router uses a Set so we can lock this contract in.
    expect(order).toEqual(['one', 'two', 'three']);
  });

  it('observer is NOT fired when the router is installed but no block is active (early-drop path)', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    // active stays null — router bails out before observer fan-out.

    const seen: Uint8Array[] = [];
    addRouterRawObserver((c) => seen.push(new Uint8Array(c)));
    appendToActiveBlock(A, B64_FOO);

    expect(seen).toHaveLength(0);
  });

  it('__emitRawChunkForTests fans out to every registered observer directly', () => {
    const seen: Uint8Array[] = [];
    addRouterRawObserver((c) => seen.push(new Uint8Array(c)));
    addRouterRawObserver((c) => seen.push(new Uint8Array(c)));

    const payload = new Uint8Array([1, 2, 3]);
    __emitRawChunkForTests(payload);

    expect(seen).toHaveLength(2);
    expect(Array.from(seen[0]!)).toEqual([1, 2, 3]);
    expect(Array.from(seen[1]!)).toEqual([1, 2, 3]);
  });

  it('a throwing observer is isolated: append does NOT throw, the error is logged at error level', () => {
    // Robustness contract: a buggy observer (programming error) must NOT
    // bring down the whole routing pipeline. The router wraps each observer
    // in try/catch, logs at `error`, and keeps going. This replaces the
    // prior "unwrapped fan-out" behavior that was pinned here — see the
    // comment on `appendToActiveBlock`'s observer loop for the rationale.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    addRouterRawObserver(() => {
      throw new Error('observer exploded');
    });

    expect(() => appendToActiveBlock(A, B64_FOO)).not.toThrow();

    // Exactly one error log for the one throw; logger tag prefix is the
    // first arg so the throw message shows up in a later arg. We assert
    // the error was logged without over-constraining the exact shape.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const firstCall = errorSpy.mock.calls[0] ?? [];
    expect(firstCall.some((arg) => arg instanceof Error && /observer exploded/u.test(arg.message))).toBe(true);
  });

  it('throwing observer does NOT block boundary detection on the same chunk', () => {
    // Pre-fix, a throwing observer bubbled out of appendToActiveBlock and
    // the `detector.feed(chunk)` + `completeBlock` code below never ran,
    // stranding the block in "running" forever. This test is the
    // regression guard: with isolation, the terminator in the chunk still
    // closes the block.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    addRouterRawObserver(() => {
      throw new Error('observer exploded mid-stream');
    });

    appendToActiveBlock(A, B64_HELLO_TERM);

    // Boundary detector still saw the chunk → preBoundary "hello" appended,
    // block completed with exitCode 0.
    expect(rec.appends).toHaveLength(1);
    expect(bytesToText(rec.appends[0]!.bytes)).toBe('hello');
    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 0 }]);
  });

  it('throwing observer in the middle of the chain does not block sibling observers before or after', () => {
    // Insertion-ordered fan-out means the failing observer sits between
    // siblings. The try/catch wrap must let both the pre-throw and
    // post-throw observers still fire for the same chunk.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    const order: string[] = [];
    addRouterRawObserver(() => order.push('first'));
    addRouterRawObserver(() => {
      order.push('second-before-throw');
      throw new Error('middle observer exploded');
    });
    addRouterRawObserver(() => order.push('third'));

    appendToActiveBlock(A, B64_FOO);

    expect(order).toEqual(['first', 'second-before-throw', 'third']);
  });

  it('__emitRawChunkForTests isolates throwing observers the same way as production fan-out', () => {
    // The test helper must mirror real semantics, otherwise tests that use
    // it to exercise observer integrations could silently diverge from
    // production behavior.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const seen: string[] = [];
    addRouterRawObserver(() => seen.push('a'));
    addRouterRawObserver(() => {
      throw new Error('helper-side observer exploded');
    });
    addRouterRawObserver(() => seen.push('c'));

    expect(() => __emitRawChunkForTests(new Uint8Array([1]))).not.toThrow();
    expect(seen).toEqual(['a', 'c']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('repeated fires of the same chunk with a throwing observer do not leak state between calls', () => {
    // A throw on call N must not poison call N+1: observer membership is
    // unchanged, sibling observers still run, and the error count grows
    // by exactly one per fire (no accidental double-log or swallow).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);

    const seen: number[] = [];
    addRouterRawObserver(() => {
      throw new Error('flaky');
    });
    addRouterRawObserver(() => seen.push(1));

    appendToActiveBlock(A, B64_FOO);
    appendToActiveBlock(A, B64_FOO);
    appendToActiveBlock(A, B64_FOO);

    // Sibling observer ran on every fire.
    expect(seen).toEqual([1, 1, 1]);
    // One error log per fire — no silent-swallow, no double-log.
    expect(errorSpy).toHaveBeenCalledTimes(3);
    // Boundary detection also ran three times (no terminator → no complete,
    // but append happened each time).
    expect(rec.appends).toHaveLength(3);
    expect(rec.completes).toHaveLength(0);
  });
});

// =====================================================================
// E. Multi-session dispose hygiene (Audit P0 fix 1)
// =====================================================================
//
// NOTE: the sibling `route-output-multi-session.test.ts` covers the P0
// regression cases. The assertions below OVERLAP intentionally so this
// file stands alone as the module's complete coverage — if the sibling
// file is ever deleted or folded away, the critical guarantees survive.

describe('dispose() multi-session pointer hygiene', () => {
  it('does NOT clear the active pointer when the active block is owned by another session', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const B = 'sess-b' as SessionId;
    const ra = installCommandRouter(A);
    installCommandRouter(B);

    rec.bindBlockToSession('blk-b' as BlockId, B);
    rec.setActive('blk-b' as BlockId);

    ra.dispose();
    expect(rec.store.getActiveBlockId()).toBe('blk-b');
  });

  it('DOES clear the active pointer when the active block belongs to the disposing session', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const ra = installCommandRouter(A);
    rec.bindBlockToSession('blk-a' as BlockId, A);
    rec.setActive('blk-a' as BlockId);

    ra.dispose();
    expect(rec.store.getActiveBlockId()).toBeNull();
  });

  it('leaves the pointer alone when the lookup port is not registered (race safety)', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    // Lookup port intentionally NOT set.

    const A = 'sess-a' as SessionId;
    const ra = installCommandRouter(A);
    rec.setActive('blk-unknown' as BlockId);

    ra.dispose();
    // Positive-confirmation posture: unknown ownership = leave it.
    expect(rec.store.getActiveBlockId()).toBe('blk-unknown');
  });

  it('leaves the pointer alone when the lookup returns undefined (block id not bound to any session)', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const ra = installCommandRouter(A);
    // Active block is set but NOT bound in the recorder's blockToSession map,
    // so `lookup` returns undefined.
    rec.setActive('blk-orphan' as BlockId);

    ra.dispose();
    expect(rec.store.getActiveBlockId()).toBe('blk-orphan');
  });

  it('no store bound → dispose is a silent no-op', () => {
    const A = 'sess-a' as SessionId;
    const ra = installCommandRouter(A);
    // No bindBlockStore call. dispose must not throw and must still detach.
    expect(() => ra.dispose()).not.toThrow();
    expect(isCommandRouterInstalled(A)).toBe(false);
  });

  it('active pointer already null → dispose leaves it null (early-return path)', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const ra = installCommandRouter(A);
    // active stays null.

    ra.dispose();
    expect(rec.store.getActiveBlockId()).toBeNull();
  });
});

// =====================================================================
// F. finalizeActiveBlock (pty_exit)
// =====================================================================

describe('finalizeActiveBlock — pty_exit handling', () => {
  it('no router for session → no-op (even with a live store and running blocks)', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    rec.setRunning(['blk-x' as BlockId]);

    finalizeActiveBlock('sess-ghost' as SessionId, 0, null);

    expect(rec.completes).toHaveLength(0);
    expect(rec.cancels).toHaveLength(0);
  });

  it('no store bound → no-op (router installed but store missing)', () => {
    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    expect(() => finalizeActiveBlock(A, 0, null)).not.toThrow();
  });

  it('completes the active block with the given exit code', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);
    rec.setRunning(['blk-a' as BlockId]);

    finalizeActiveBlock(A, 42, null);

    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 42 }]);
    expect(rec.cancels).toHaveLength(0);
  });

  it('propagates a null exit code (signal-only exit)', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);
    rec.setRunning(['blk-a' as BlockId]);

    finalizeActiveBlock(A, null, 'SIGHUP');

    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: null }]);
  });

  it('cancels every running block that is NOT the active one', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-active' as BlockId);
    rec.setRunning([
      'blk-active' as BlockId,
      'blk-ghost-1' as BlockId,
      'blk-ghost-2' as BlockId,
    ]);

    finalizeActiveBlock(A, 0, null);

    expect(rec.completes).toEqual([{ id: 'blk-active', exitCode: 0 }]);
    expect(rec.cancels).toEqual(['blk-ghost-1', 'blk-ghost-2']);
  });

  it('clears the active pointer after finalizing (unconditional null write)', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);
    rec.setRunning(['blk-a' as BlockId]);

    finalizeActiveBlock(A, 0, null);

    expect(rec.store.getActiveBlockId()).toBeNull();
  });

  it('no running blocks at all → simply clears the active pointer', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive('blk-stale' as BlockId);
    rec.setRunning([]);

    finalizeActiveBlock(A, 0, null);

    expect(rec.completes).toHaveLength(0);
    expect(rec.cancels).toHaveLength(0);
    expect(rec.store.getActiveBlockId()).toBeNull();
  });

  it('running blocks with NO active pointer → every running block is cancelled', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.setActive(null);
    rec.setRunning(['blk-1' as BlockId, 'blk-2' as BlockId]);

    finalizeActiveBlock(A, 0, null);

    expect(rec.completes).toHaveLength(0);
    expect(rec.cancels).toEqual(['blk-1', 'blk-2']);
  });
});

// =====================================================================
// G. Test helpers self-check
// =====================================================================

describe('__resetRouterForTests & friends', () => {
  it('clears router handles across all sessions', () => {
    const A = 'sess-a' as SessionId;
    const B = 'sess-b' as SessionId;
    installCommandRouter(A);
    installCommandRouter(B);
    expect(isCommandRouterInstalled(A)).toBe(true);
    expect(isCommandRouterInstalled(B)).toBe(true);

    __resetRouterForTests();

    expect(isCommandRouterInstalled(A)).toBe(false);
    expect(isCommandRouterInstalled(B)).toBe(false);
  });

  it('clears raw chunk observers', () => {
    const seen: number[] = [];
    addRouterRawObserver(() => seen.push(1));
    __emitRawChunkForTests(new Uint8Array([0]));
    expect(seen).toHaveLength(1);

    __resetRouterForTests();

    __emitRawChunkForTests(new Uint8Array([0]));
    expect(seen).toHaveLength(1);
  });

  it('clears the block-session lookup port so a subsequent dispose reverts to no-lookup behavior', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    __resetRouterForTests();

    // Re-install and verify dispose now takes the "no lookup" conservative
    // branch: with active pointer set but lookup cleared, pointer survives.
    const A = 'sess-a' as SessionId;
    const ra = installCommandRouter(A);
    rec.setActive('blk-a' as BlockId);
    ra.dispose();

    expect(rec.store.getActiveBlockId()).toBe('blk-a');
  });

  it('clears the store active pointer when the store is bound at reset time', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    rec.setActive('blk-will-be-cleared' as BlockId);

    __resetRouterForTests();

    expect(rec.store.getActiveBlockId()).toBeNull();
  });

  it('__resetRawObserversForTests removes all observers without touching router handles', () => {
    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    const seen: number[] = [];
    addRouterRawObserver(() => seen.push(1));

    __resetRawObserversForTests();

    // Observer gone…
    __emitRawChunkForTests(new Uint8Array([0]));
    expect(seen).toHaveLength(0);
    // …but router still installed.
    expect(isCommandRouterInstalled(A)).toBe(true);
  });
});

// =====================================================================
// H. Install options — real-shell boundary-detector opt-out
// =====================================================================
//
// The Phase-2 mock boundary detector scans every chunk for
// `MOCK_PROMPT_BYTES`. That is correct for the in-browser mock bridge,
// which synthesizes exactly those bytes after every command, but WRONG
// for a real zsh spawned by the Tauri sidecar: real output can contain
// the sequence by coincidence (coloured `$` glyphs in themed prompts,
// styled git-status segments, ANSI-coloured command output) and the
// router would then mis-split the block and drop every byte following
// the false-positive match — the user-visible bug where `ls` arrives as
// `lls` and `cd data` arrives as `s` / `cd d` with the `data` suffix
// leaking into the next block.
//
// The fix threads an `options.detector` through `installCommandRouter`:
//   - undefined (default) keeps the mock detector (legacy behavior for
//     every existing test site and for the mock bridge);
//   - `null` opts out of boundary scanning entirely, which is what the
//     real-shell install path uses until an OSC 133 detector ships;
//   - a factory function will hold the future OSC 133 detector.
// The tests below pin every branch.

describe('installCommandRouter — options.detector', () => {
  // "hello" + full MOCK_PROMPT_BYTES terminator, base64. Intentionally the
  // exact byte sequence that would CLOSE a block under the legacy default.
  // Shared with the C-suite fixtures above but redeclared locally so this
  // describe block reads standalone.
  const B64_HELLO_WITH_FAKE_TERM = B64_HELLO_TERM;

  it('detector: null → mock-prompt bytes do NOT close the block (real-shell fix)', () => {
    // This is the direct regression guard for the real-shell command-mangling
    // bug. A real zsh can emit bytes that match MOCK_PROMPT_BYTES by chance;
    // without the opt-out, those bytes would close the block prematurely and
    // drop the tail of the current command.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, { detector: null });
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_HELLO_WITH_FAKE_TERM);

    // The whole chunk (hello + the 11 terminator bytes) lands on the block
    // verbatim. NOTHING is discarded, NOTHING closes the block.
    expect(rec.completes).toHaveLength(0);
    expect(rec.appends).toHaveLength(1);
    // 5 ("hello") + 11 (MOCK_PROMPT_BYTES) = 16 bytes flowed through.
    expect(rec.appends[0]!.bytes.length).toBe(16);
    // Active block pointer is still the same — no boundary was signalled.
    expect(rec.store.getActiveBlockId()).toBe('blk-a');
  });

  it('detector: null → partial-terminator chunks also flow verbatim (no carry)', () => {
    // The legacy detector would have carried 5 bytes forward waiting for the
    // rest of the terminator. A null detector must NOT carry — every chunk
    // flushes in full as it arrives, matching the real-shell policy of
    // "bytes are just output; boundaries come from pty_exit".
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, { detector: null });
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_HELLO_PARTIAL_TERM); // "hello" + 5-byte partial
    appendToActiveBlock(A, B64_TERM_REST); // 6-byte rest

    // No boundary signalled on either feed.
    expect(rec.completes).toHaveLength(0);
    // Both chunks appended in full.
    expect(rec.appends).toHaveLength(2);
    // Byte totals: 10 (hello + 5 partial) and 6 (rest).
    expect(rec.appends[0]!.bytes.length).toBe(10);
    expect(rec.appends[1]!.bytes.length).toBe(6);
  });

  it('detector: null → finalize still closes the active block with pty_exit code', () => {
    // With boundary detection disabled, `pty_exit` becomes the sole close
    // signal. Pin that path explicitly so a future refactor does not
    // accidentally untangle finalize from the null-detector case.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, { detector: null });
    rec.setActive('blk-a' as BlockId);
    rec.setRunning(['blk-a' as BlockId]);

    appendToActiveBlock(A, B64_FOO); // no boundary, just output
    finalizeActiveBlock(A, 0, null);

    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 0 }]);
    expect(rec.store.getActiveBlockId()).toBeNull();
  });

  it('default (undefined) preserves legacy mock-bridge boundary behavior', () => {
    // Backwards-compat guard: the change is opt-in. Existing tests and the
    // mock bridge continue to see block closes on MOCK_PROMPT_BYTES.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A); // no options
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_HELLO_WITH_FAKE_TERM);

    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 0 }]);
    expect(bytesToText(rec.appends[0]!.bytes)).toBe('hello');
  });

  it('factory form: detector factory is called once per block (fresh instance after boundary)', () => {
    // The factory must be invoked on install AND after every boundary so the
    // detector never carries state from the previous block. We install with
    // a spying factory that returns the mock detector; exercise a boundary;
    // assert the factory fired twice (install + re-create).
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const factory = vi.fn(() => createMockBoundaryDetector());
    const A = 'sess-a' as SessionId;
    installCommandRouter(A, { detector: factory });
    rec.setActive('blk-a' as BlockId);

    // Install calls the factory once.
    expect(factory).toHaveBeenCalledTimes(1);

    // Trigger a boundary: the router should create a fresh detector after
    // closing the block so carry from the previous block can't leak.
    appendToActiveBlock(A, B64_HELLO_WITH_FAKE_TERM);
    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 0 }]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('factory returning null per block = behaves identically to passing detector: null', () => {
    // A factory that always returns null should be indistinguishable from
    // the null shorthand. Pin both branches emit the same observable
    // behaviour so a future "factory-never-null" invariant can't be snuck
    // in without updating this test.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, { detector: () => null });
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_HELLO_WITH_FAKE_TERM);

    // No boundary signalled; full chunk appended.
    expect(rec.completes).toHaveLength(0);
    expect(rec.appends).toHaveLength(1);
    expect(rec.appends[0]!.bytes.length).toBe(16);
  });

  it('simulated real-zsh stream: output containing MOCK_PROMPT_BYTES across multiple commands does not mis-split', () => {
    // End-to-end style scenario mirroring the user bug report: three
    // consecutive commands (`ls`, `ls`, `cd data`) each land as one or
    // more chunks that happen to contain the MOCK_PROMPT_BYTES sequence
    // somewhere inside. Under the legacy default every accidental match
    // would close the block and drop the tail; under the real-shell
    // install path nothing should close until `finalizeActiveBlock`.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, { detector: null });
    rec.setActive('blk-a' as BlockId);

    // Feed two chunks, each ending in MOCK_PROMPT_BYTES — exactly the
    // pattern an oh-my-zsh themed prompt produces around a `$`/`%` glyph.
    // The base64 fixtures are the same ones the mock-branch tests use, so
    // the byte content is identical — only the detector choice differs.
    appendToActiveBlock(A, B64_HELLO_WITH_FAKE_TERM);
    appendToActiveBlock(A, B64_HELLO_WITH_FAKE_TERM);

    // Both chunks flowed to the same block. No premature close, no split.
    expect(rec.completes).toHaveLength(0);
    expect(rec.appends).toHaveLength(2);
    expect(rec.store.getActiveBlockId()).toBe('blk-a');
    // Full 16-byte chunk each time (5 payload + 11 mock-prompt bytes).
    expect(rec.appends[0]!.bytes.length).toBe(16);
    expect(rec.appends[1]!.bytes.length).toBe(16);
  });

  it('raw observers still fire when detector is null (side-channel is independent of boundary detection)', () => {
    // The TUI alt-screen detector and similar hooks ride the raw observer
    // channel. They must not be coupled to the existence of a boundary
    // detector — a real-shell session (no detector) still needs to fan
    // out raw chunks.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const seen: Uint8Array[] = [];
    addRouterRawObserver((c) => seen.push(new Uint8Array(c)));

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, { detector: null });
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_FOO);

    expect(seen).toHaveLength(1);
    expect(bytesToText(seen[0]!)).toBe('foo');
    // Store still received the bytes, too — observer and append are
    // independent.
    expect(rec.appends).toHaveLength(1);
  });
});

// =====================================================================
// I. Idle-based auto-completion (real-shell fallback)
// =====================================================================
//
// Real-shell sessions install with `detector: null` (see suite H above).
// That means `pty_exit` / next-submit cancel are the ONLY block-close
// signals — and interactive zsh never emits `pty_exit` between commands,
// so blocks would stay in `running` forever (the user-visible "spinner
// spins forever" bug). The idle timer is the poor-man's boundary: when
// the PTY goes silent for `idleCompletionMs` ms, we assume the prompt
// has been drawn and auto-complete the block with exit code 0.
//
// We use `vi.useFakeTimers` so these tests run in microseconds and so
// timer races are deterministic. Every test in this suite tears the
// fake timers down in an inner `afterEach` to avoid leaking faked
// `setTimeout` into unrelated suites.

describe('appendToActiveBlock — idle auto-completion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drain any pending timers before restoring real ones so a stray
    // scheduled `completeBlock` can't fire into the next suite.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('detector null + idleCompletionMs: auto-completes the active block after the idle window', () => {
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, {
      detector: null,
      idleCompletionMs: IDLE_COMPLETE_MS,
    });
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_FOO);
    // Timer is armed but hasn't fired yet.
    expect(rec.completes).toHaveLength(0);

    // Just under the window — still running.
    vi.advanceTimersByTime(IDLE_COMPLETE_MS - 1);
    expect(rec.completes).toHaveLength(0);

    // Cross the boundary: timer fires, block auto-completes.
    vi.advanceTimersByTime(1);
    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 0 }]);
    // Active pointer was cleared by the recorder's `completeBlock` impl.
    expect(rec.store.getActiveBlockId()).toBeNull();
  });

  it('consecutive chunks reset the idle window (long-running command stays running)', () => {
    // Regression guard against a "first-append-wins" off-by-one: the timer
    // must be re-armed on every chunk, otherwise a long command that pauses
    // briefly between stdout flushes would be marked complete mid-stream.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, {
      detector: null,
      idleCompletionMs: IDLE_COMPLETE_MS,
    });
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_FOO);
    // Wait almost the full window, then append again — timer must reset.
    vi.advanceTimersByTime(IDLE_COMPLETE_MS - 50);
    appendToActiveBlock(A, B64_BAR);
    // Advance to what WOULD have been the original fire time: the timer
    // should NOT have fired (it was cleared and re-armed).
    vi.advanceTimersByTime(60);
    expect(rec.completes).toHaveLength(0);

    // Now actually wait out the full window from the last append.
    vi.advanceTimersByTime(IDLE_COMPLETE_MS);
    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 0 }]);
  });

  it('default (mock) detector install does NOT auto-complete on idle', () => {
    // The idle timer is opt-in via `idleCompletionMs`. The mock bridge /
    // existing test sites pass no options and must see zero behavior change:
    // the MOCK_PROMPT_BYTES terminator is still the only close signal, and
    // a chunk without one leaves the block running indefinitely under fake
    // timers.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A); // default: mock detector, no idle timer
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_FOO); // no terminator, no boundary
    vi.advanceTimersByTime(IDLE_COMPLETE_MS * 10);

    expect(rec.completes).toHaveLength(0);
    expect(rec.store.getActiveBlockId()).toBe('blk-a');
  });

  it('finalizeActiveBlock clears the pending idle timer (no double-close)', () => {
    // When `pty_exit` lands, finalize closes the block authoritatively. A
    // pending idle timer must be dropped so it can't (a) fire a second
    // completeBlock on the now-null active pointer or (b) race with a
    // freshly-spawned successor session's block.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, {
      detector: null,
      idleCompletionMs: IDLE_COMPLETE_MS,
    });
    rec.setActive('blk-a' as BlockId);
    rec.setRunning(['blk-a' as BlockId]);

    appendToActiveBlock(A, B64_FOO);
    // pty_exit arrives before the idle window elapses.
    finalizeActiveBlock(A, 42, null);
    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 42 }]);

    // Run any remaining timers — the idle timer must have been cancelled
    // so no second completeBlock fires.
    vi.runAllTimers();
    expect(rec.completes).toHaveLength(1);
  });

  it('dispose cancels the pending idle timer (leak prevention)', () => {
    // A timer that outlives the router's session is a leak vector: if a
    // sibling session installs next, the stale timer could fire and close
    // THAT session's active block. The dispose() path must proactively
    // clear, regardless of whether the fire-time guard would catch it.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const ra = installCommandRouter(A, {
      detector: null,
      idleCompletionMs: IDLE_COMPLETE_MS,
    });
    rec.bindBlockToSession('blk-a' as BlockId, A);
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_FOO);
    // Dispose BEFORE the timer fires.
    ra.dispose();
    // After dispose, active pointer was cleared (owned by A). Run timers —
    // the disposed timer must NOT fire.
    vi.runAllTimers();
    expect(rec.completes).toHaveLength(0);
  });

  it('idle timer does not fire when active pointer has moved to a new block', () => {
    // If the user submits a second command before the idle window elapses,
    // `submitCommand` allocates a new active block. The stale timer's
    // fire-time guard (`currentActive !== activeAtScheduleTime`) must skip
    // the close so the new block is not accidentally terminated.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, {
      detector: null,
      idleCompletionMs: IDLE_COMPLETE_MS,
    });
    rec.setActive('blk-1' as BlockId);

    appendToActiveBlock(A, B64_FOO);
    // Simulate `submitCommand` flipping the active pointer to a new block.
    // In production `submitCommand` also cancels the old block; we skip
    // that step to isolate the guard under test.
    rec.setActive('blk-2' as BlockId);

    vi.advanceTimersByTime(IDLE_COMPLETE_MS + 10);

    // Guard must have skipped: neither block was completed by the idle
    // timer (blk-1 wasn't current; blk-2 wasn't the one we scheduled for).
    expect(rec.completes).toHaveLength(0);
    expect(rec.store.getActiveBlockId()).toBe('blk-2');
  });

  it('re-install on same session clears the prior handle\'s pending idle timer', () => {
    // Defense in depth — the same-session replace path (tested for detector
    // replacement in suite A) must also drop the stale timer so it can't
    // fire into the new handle's state. The new handle's own guard would
    // also catch it, but proactively clearing keeps the behaviour
    // deterministic in case future refactors touch the guard.
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, {
      detector: null,
      idleCompletionMs: IDLE_COMPLETE_MS,
    });
    rec.setActive('blk-a' as BlockId);
    appendToActiveBlock(A, B64_FOO); // arms timer on first handle

    // Re-install without an idle timer configured — the stale timer from
    // the previous handle must not fire.
    installCommandRouter(A, { detector: null });

    vi.advanceTimersByTime(IDLE_COMPLETE_MS * 2);
    expect(rec.completes).toHaveLength(0);
  });

  it('empty chunk still re-arms the idle timer (tracks "time since any pty_data")', () => {
    // The idle window represents "time since the host last spoke to us",
    // not "time since the host said something useful". An empty-payload
    // pty_data frame is still a signal that the PTY is alive, so it must
    // reset the timer. (This matters for shell integrations that emit
    // zero-byte marker events.)
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A, {
      detector: null,
      idleCompletionMs: IDLE_COMPLETE_MS,
    });
    rec.setActive('blk-a' as BlockId);

    appendToActiveBlock(A, B64_FOO);
    vi.advanceTimersByTime(IDLE_COMPLETE_MS - 50);
    // Empty chunk — the router's >0 guard skips appendBlockOutput but the
    // idle timer still re-arms from the handle.
    appendToActiveBlock(A, '');
    vi.advanceTimersByTime(60);
    expect(rec.completes).toHaveLength(0);

    vi.advanceTimersByTime(IDLE_COMPLETE_MS);
    expect(rec.completes).toEqual([{ id: 'blk-a', exitCode: 0 }]);
  });

  it('IDLE_COMPLETE_MS is a positive number (sanity check)', () => {
    // Pinning the constant's shape so a future refactor to `null` default
    // or a zero/negative value fails loudly. The exact value is a product
    // decision — don't pin it here.
    expect(IDLE_COMPLETE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(IDLE_COMPLETE_MS)).toBe(true);
  });

  it('alt-screen active SUPPRESSES idle completion (user reading in vim/less must not trip the spinner off)', async () => {
    // Regression for D1: the user opens `less` or `vim`, stops producing
    // output, and sits reading. The idle timer used to fire 400 ms later
    // and mark the block `complete` (with exit code 0 fabricated) while
    // the program is obviously still running. Subsequent keystrokes'
    // output would then land on a "done" block. The fix gates idle
    // scheduling on `useTuiStore().active === false`.
    const { useTuiStore } = await import('../../../entities/tui/index.js');
    vi.useFakeTimers();
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    const A = 'sess-a' as SessionId;
    installCommandRouter(A, { detector: null, idleCompletionMs: IDLE_COMPLETE_MS });
    rec.setActive('blk-a' as BlockId);
    // Enter alt-screen BEFORE any chunk arrives.
    useTuiStore.getState().enter();
    appendToActiveBlock(A, B64_FOO);
    // Advance past the idle window — no completion should fire because
    // we're inside a TUI.
    vi.advanceTimersByTime(IDLE_COMPLETE_MS + 50);
    expect(rec.completes.length).toBe(0);
    useTuiStore.getState().exit();
    vi.useRealTimers();
  });

  it('entering alt-screen MID-WINDOW cancels a pending idle timer', async () => {
    // Variant: user finished a shell command, idle timer armed. Before
    // 400 ms elapses they invoke vim (say, via a shell alias) → alt
    // screen active — we must NOT then still close the block.
    const { useTuiStore } = await import('../../../entities/tui/index.js');
    vi.useFakeTimers();
    const rec = makeRecorder();
    unbindStore = bindBlockStore(rec.store);
    const A = 'sess-a' as SessionId;
    installCommandRouter(A, { detector: null, idleCompletionMs: IDLE_COMPLETE_MS });
    rec.setActive('blk-a' as BlockId);
    appendToActiveBlock(A, B64_FOO);
    // Timer armed. Advance half the window.
    vi.advanceTimersByTime(Math.floor(IDLE_COMPLETE_MS / 2));
    // User opens a TUI. The NEXT chunk re-schedules (or doesn't).
    useTuiStore.getState().enter();
    appendToActiveBlock(A, B64_BAR);
    // Advance past what would have been the original fire time AND the
    // re-armed window. No completion.
    vi.advanceTimersByTime(IDLE_COMPLETE_MS * 2);
    expect(rec.completes.length).toBe(0);
    useTuiStore.getState().exit();
    vi.useRealTimers();
  });
});

