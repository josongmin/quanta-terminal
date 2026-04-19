/**
 * **E2E — session tab switch, mirror swap, and selection reset**
 *
 * Pipeline under test:
 *
 *     click / switchSession(id) →
 *     useSessionsStore.setActive(id) →
 *     harness re-renders, selects that session's GridMirror →
 *     TerminalCanvas remounts/re-inits on mirror prop change →
 *     CellBuffer re-seeds from the new mirror's snapshot →
 *     the old session's selection state does NOT leak into the new session.
 *
 * Session-tabs structural findings (production):
 *   - `createSession` / `closeSession` / `switchSession` in
 *     `features/session-tabs/actions.ts` are the ONLY lifecycle entry
 *     points. Each spawns through `connectSession` (which calls
 *     `bridge.spawn`) and registers the resulting `ConnectedSession`
 *     handle in a feature-scoped `connection-map`.
 *   - `useSessionsStore` (the multi-session collection) holds `order`,
 *     `entities`, `activeId`. The legacy singular `useSessionStore` is
 *     a projected mirror of the active entity.
 *   - There is NO per-session GridMirror in the production tree today.
 *     `TerminalPage` currently renders `BlockList` as the main surface
 *     (`TerminalCanvas` is not mounted on the canvas path in production;
 *     only the dev-only `SideBySideHarness` constructs a mirror). The
 *     per-session mirror "store" therefore lives in this harness — that
 *     is explicitly permitted by the test brief ("mirror prop 교체").
 *
 * What we assert here is the contract the UI layer has to honor:
 *   (a) each session OWNS a distinct mirror;
 *   (b) switching sessions re-plumbs the TerminalCanvas onto the new mirror
 *       (CellBuffer contents reflect the new session's grid);
 *   (c) the cell-renderer's SelectionManager is tied to the buffer, so a
 *       mirror swap guarantees a fresh SelectionManager — prior selection
 *       does NOT appear on the new session's grid (no oversharing);
 *   (d) selection in session A remains attached to A's buffer (per-session
 *       selection state independence);
 *   (e) session close → neighbor auto-adopts active (browser tab UX);
 *   (f) closing the last session empties the collection (the page-level
 *       auto-respawn is TerminalPage policy, out of scope here).
 */

import { act, cleanup, render } from '@testing-library/react';
import { createRef, useMemo, useRef, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSessionsStore } from '../../entities/session/index.js';
import { useTuiStore } from '../../entities/tui/index.js';
import {
  switchSession,
} from '../../features/session-tabs/index.js';
import { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import type {
  CellSpan,
  GridEventEnvelope,
  GridSnapshotPayload,
  RowDelta,
} from '../../shared/lib/grid-mirror/types.js';
import {
  DEFAULT_METRICS,
  MirrorSource,
} from '../../shared/ui/cell-renderer/index.js';
import {
  TerminalCanvas,
  type TerminalCanvasHandle,
} from '../../widgets/terminal-canvas/TerminalCanvas.js';
import type { SessionId } from '../../shared/types/generated/index.js';

/* -------------------------------------------------------------------------- */
/*  Wire-event builders                                                        */
/* -------------------------------------------------------------------------- */

function textSpan(text: string): CellSpan {
  return {
    cols: text.length,
    sgr: '0x0000000000000000',
    graphemes: { utf8: text },
    hyperlink_id: 0,
    ext: null,
  };
}

function blankSpan(cols: number): CellSpan {
  return {
    cols,
    sgr: '0x0000000000000000',
    graphemes: 'blank',
    hyperlink_id: 0,
    ext: null,
  };
}

function snapshotEnv(opts: {
  sessionId: string;
  rows: number;
  cols: number;
  contents: readonly string[];
  epoch?: number;
  resizeGen?: number;
}): GridEventEnvelope<GridSnapshotPayload> {
  const row_deltas: RowDelta[] = [];
  for (let r = 0; r < opts.rows; r += 1) {
    const text = opts.contents[r] ?? '';
    row_deltas.push({
      row: r,
      revision_before: 0,
      revision_after: 1,
      spans:
        text.length > 0
          ? [textSpan(text), blankSpan(Math.max(0, opts.cols - text.length))]
          : [blankSpan(opts.cols)],
      continuation: false,
      hyperlink_refs: [],
    });
  }
  return {
    session_id: opts.sessionId,
    grid_epoch: opts.epoch ?? 1,
    sequence_no: 0,
    resize_generation: opts.resizeGen ?? 0,
    buffer_kind: 'main',
    payload: {
      kind: 'grid_snapshot',
      rows: opts.rows,
      cols: opts.cols,
      buffer_kind: 'main',
      row_deltas,
      cursor: {
        row: 0,
        col: 0,
        visible: true,
        shape: 'block',
        blinking: false,
        pending_wrap: false,
      },
      mode_state: {},
      meta: {},
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Per-session mirror store + harness                                         */
/* -------------------------------------------------------------------------- */

interface SessionMirrorEntry {
  readonly mirror: GridMirror;
  readonly source: MirrorSource;
}

/** Factory — creates a fresh `GridMirror` + `MirrorSource` per session and
 *  seeds it with a snapshot whose row 0 encodes the session id. This is the
 *  "per-session mirror" model the harness owns; production TerminalPage
 *  would plumb a similar map when the canvas path lights up end-to-end. */
function makeSessionMirror(opts: {
  sessionId: string;
  rows?: number;
  cols?: number;
  contents?: readonly string[];
  epoch?: number;
}): SessionMirrorEntry {
  const rows = opts.rows ?? 4;
  const cols = opts.cols ?? 16;
  const source = new MirrorSource();
  const mirror = new GridMirror({ onChange: (d) => source.emit(d) });
  mirror.applySnapshot(
    snapshotEnv({
      sessionId: opts.sessionId,
      rows,
      cols,
      contents: opts.contents ?? [`sess:${opts.sessionId}`],
      ...(opts.epoch !== undefined ? { epoch: opts.epoch } : {}),
    }),
  );
  return { mirror, source };
}

/**
 * Harness — reads `activeId` from the store and plumbs the matching mirror
 * into `TerminalCanvas`. The `key={activeId}` forces a clean remount so the
 * imperative handle (and its `SelectionManager` + `CellBuffer`) is fresh
 * per session; this matches the production expectation that switching tabs
 * re-initializes the per-tab render surface.
 */
function Harness(props: {
  readonly mirrors: ReadonlyMap<SessionId, SessionMirrorEntry>;
  readonly canvasRef: Ref<TerminalCanvasHandle>;
}): JSX.Element {
  const activeId = useSessionsStore((s) => s.activeId);
  // Count how many times the canvas gets re-mounted — surfaces in a
  // data- attribute so the mirror-swap behavior is observable from tests.
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const entry = useMemo(() => {
    if (activeId === null) return null;
    return props.mirrors.get(activeId) ?? null;
  }, [activeId, props.mirrors]);
  if (!entry) {
    return <div data-testid="harness-empty" data-active="null" />;
  }
  return (
    <div
      data-testid="harness"
      data-active={activeId ?? ''}
      data-render-count={String(renderCountRef.current)}
    >
      <TerminalCanvas
        key={activeId ?? undefined}
        ref={props.canvasRef}
        mirror={entry.mirror}
        mirrorSource={entry.source}
        backend="memory"
        metrics={DEFAULT_METRICS}
        platform="linux"
      />
    </div>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/* -------------------------------------------------------------------------- */
/*  Setup                                                                      */
/* -------------------------------------------------------------------------- */

const ID_A = 'sess-A' as SessionId;
const ID_B = 'sess-B' as SessionId;

beforeEach(() => {
  useSessionsStore.getState().reset();
  useTuiStore.getState().reset();
  // Seed the collection directly — we bypass `createSession` to avoid
  // pulling in a scripted `HostBridge`. The lifecycle semantics we exercise
  // (setActive / removeSession) are the same ones `switchSession` and
  // `closeSession` delegate to, and are independently covered by
  // `features/session-tabs/__tests__/actions.test.ts`.
  const coll = useSessionsStore.getState();
  coll.addSession({ id: ID_A });
  coll.addSession({ id: ID_B });
  // `addSession` auto-adopts the first as active, so `ID_A` is active here.
});

afterEach(() => {
  cleanup();
  useSessionsStore.getState().reset();
  useTuiStore.getState().reset();
});

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('session tab switch (e2e, mirror swap + selection reset)', () => {
  it('two sessions in the collection own DISTINCT GridMirror instances', async () => {
    const entryA = makeSessionMirror({ sessionId: ID_A, contents: ['alpha'] });
    const entryB = makeSessionMirror({ sessionId: ID_B, contents: ['bravo'] });
    expect(entryA.mirror).not.toBe(entryB.mirror);
    expect(entryA.source).not.toBe(entryB.source);
    // And the collection reports both sessions, with A active by seed order.
    const s = useSessionsStore.getState();
    expect(s.order).toEqual([ID_A, ID_B]);
    expect(s.activeId).toBe(ID_A);
  });

  it('initial render with A active plumbs A\'s mirror into the canvas (row 0 = alpha)', async () => {
    const mirrors = new Map<SessionId, SessionMirrorEntry>([
      [ID_A, makeSessionMirror({ sessionId: ID_A, contents: ['alpha'] })],
      [ID_B, makeSessionMirror({ sessionId: ID_B, contents: ['bravo'] })],
    ]);
    const ref = createRef<TerminalCanvasHandle>();
    render(<Harness mirrors={mirrors} canvasRef={ref as Ref<TerminalCanvasHandle>} />);
    await flush();
    expect(ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('alpha');
  });

  it('switchSession(B) swaps the canvas onto B\'s mirror — row 0 now reads bravo', async () => {
    const mirrors = new Map<SessionId, SessionMirrorEntry>([
      [ID_A, makeSessionMirror({ sessionId: ID_A, contents: ['alpha'] })],
      [ID_B, makeSessionMirror({ sessionId: ID_B, contents: ['bravo'] })],
    ]);
    const ref = createRef<TerminalCanvasHandle>();
    render(<Harness mirrors={mirrors} canvasRef={ref as Ref<TerminalCanvasHandle>} />);
    await flush();
    expect(ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('alpha');
    act(() => {
      switchSession(ID_B);
    });
    await flush();
    expect(useSessionsStore.getState().activeId).toBe(ID_B);
    expect(ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('bravo');
  });

  it('selection on session A does NOT persist onto session B after the switch', async () => {
    const mirrors = new Map<SessionId, SessionMirrorEntry>([
      [ID_A, makeSessionMirror({ sessionId: ID_A, contents: ['alpha'] })],
      [ID_B, makeSessionMirror({ sessionId: ID_B, contents: ['bravo'] })],
    ]);
    const ref = createRef<TerminalCanvasHandle>();
    render(<Harness mirrors={mirrors} canvasRef={ref as Ref<TerminalCanvasHandle>} />);
    await flush();
    // Begin a selection in session A through the real SelectionManager.
    const selectionA = ref.current!.selection;
    act(() => {
      selectionA.begin({ row: 0, col: 0 }, 'char');
      selectionA.extend({ row: 0, col: 5 });
    });
    expect(selectionA.get()).not.toBeNull();
    expect(selectionA.copy()).toContain('alpha');
    // Switch to B — the canvas remounts with B's mirror, so the
    // SelectionManager the canvas now holds is a BRAND NEW instance.
    act(() => {
      switchSession(ID_B);
    });
    await flush();
    const selectionB = ref.current!.selection;
    // Different underlying object — per-session selection isolation.
    expect(selectionB).not.toBe(selectionA);
    // And B's selection starts clean (no leak of A's anchor).
    expect(selectionB.get()).toBeNull();
    expect(selectionB.copy()).toBe('');
  });

  it('switching back to A presents a FRESH canvas — A\'s selection does not magically survive', async () => {
    // Documents the policy consequence of `key={activeId}` remount:
    // selection is buffer-scoped, and each remount gets a new buffer, so
    // coming back to A means A's SelectionManager also starts empty.
    // (This aligns with the "no oversharing" invariant; if product wants
    // selection persistence across switches it must live outside the
    // canvas — which is separate from the fact that A's grid CONTENT is
    // still intact because the mirror is persisted in the test harness.)
    const mirrors = new Map<SessionId, SessionMirrorEntry>([
      [ID_A, makeSessionMirror({ sessionId: ID_A, contents: ['alpha'] })],
      [ID_B, makeSessionMirror({ sessionId: ID_B, contents: ['bravo'] })],
    ]);
    const ref = createRef<TerminalCanvasHandle>();
    render(<Harness mirrors={mirrors} canvasRef={ref as Ref<TerminalCanvasHandle>} />);
    await flush();
    act(() => {
      ref.current!.selection.begin({ row: 0, col: 0 }, 'char');
      ref.current!.selection.extend({ row: 0, col: 5 });
    });
    expect(ref.current!.selection.copy()).toContain('alpha');
    act(() => {
      switchSession(ID_B);
    });
    await flush();
    act(() => {
      switchSession(ID_A);
    });
    await flush();
    // A's mirror content is still there (harness retained it).
    expect(ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('alpha');
    // But the canvas selection is fresh (remount on key change).
    expect(ref.current?.selection.get()).toBeNull();
  });

  it('closing the active session promotes the right-neighbor to active', async () => {
    // `removeSession` drives the same path `closeSession(id)` awaits.
    expect(useSessionsStore.getState().activeId).toBe(ID_A);
    act(() => {
      useSessionsStore.getState().removeSession(ID_A);
    });
    const s = useSessionsStore.getState();
    expect(s.order).toEqual([ID_B]);
    expect(s.activeId).toBe(ID_B);
  });

  it('closing the last session leaves the collection empty and active=null (page-level respawn is out of scope)', async () => {
    act(() => {
      useSessionsStore.getState().removeSession(ID_A);
      useSessionsStore.getState().removeSession(ID_B);
    });
    const s = useSessionsStore.getState();
    expect(s.order).toEqual([]);
    expect(s.activeId).toBeNull();
  });

  it('per-session grid_epoch and resize_generation are independent', async () => {
    // A bumped to epoch 3; B at epoch 1. A discards a stale delta for
    // epoch 1 but B, with its own mirror, is unaffected.
    const entryA = makeSessionMirror({ sessionId: ID_A, contents: ['alpha'], epoch: 3 });
    const entryB = makeSessionMirror({ sessionId: ID_B, contents: ['bravo'], epoch: 1 });
    // Applying a stale-epoch snapshot to A is a no-op (discarded); B is
    // untouched because it never saw the envelope at all.
    const staleEnv: GridEventEnvelope<GridSnapshotPayload> = snapshotEnv({
      sessionId: ID_A,
      rows: 4,
      cols: 16,
      contents: ['STALE'],
      epoch: 1,
    });
    const result = entryA.mirror.applySnapshot(staleEnv);
    expect(result.outcome).toBe('discarded');
    // B's mirror never observed `staleEnv` — it continues to report 'bravo'.
    const mirrors = new Map<SessionId, SessionMirrorEntry>([
      [ID_A, entryA],
      [ID_B, entryB],
    ]);
    const ref = createRef<TerminalCanvasHandle>();
    render(<Harness mirrors={mirrors} canvasRef={ref as Ref<TerminalCanvasHandle>} />);
    await flush();
    expect(ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('alpha');
    act(() => {
      switchSession(ID_B);
    });
    await flush();
    expect(ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('bravo');
  });

  it('TUI store sessionId plumbs through a session switch (alt-screen label follows active tab)', async () => {
    // The TUI entity (`useTuiStore`) is a singular store keyed by
    // `sessionId`. When the active session flips, a production consumer
    // (TerminalPage's effect on `activeSessionId`) updates the store so
    // AltScreenStatusBar shows the right label. We simulate that
    // consumer explicitly here to lock in the contract.
    const mirrors = new Map<SessionId, SessionMirrorEntry>([
      [ID_A, makeSessionMirror({ sessionId: ID_A, contents: ['alpha'] })],
      [ID_B, makeSessionMirror({ sessionId: ID_B, contents: ['bravo'] })],
    ]);
    const ref = createRef<TerminalCanvasHandle>();
    render(<Harness mirrors={mirrors} canvasRef={ref as Ref<TerminalCanvasHandle>} />);
    await flush();
    // Enter alt-screen on A with a label.
    act(() => {
      useTuiStore.getState().enter({ command: 'vim', sessionId: ID_A });
    });
    expect(useTuiStore.getState().sessionId).toBe(ID_A);
    expect(useTuiStore.getState().active).toBe(true);
    // Switch tabs — production TerminalPage's effect re-plumbs sessionId.
    act(() => {
      switchSession(ID_B);
      useTuiStore.setState({ sessionId: ID_B });
    });
    await flush();
    expect(useSessionsStore.getState().activeId).toBe(ID_B);
    expect(useTuiStore.getState().sessionId).toBe(ID_B);
    // Canvas also swapped to B's grid.
    expect(ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('bravo');
  });

  it('mirror swap remounts the CellBuffer — the new buffer is not the same object as the prior one', async () => {
    // Direct identity check on the buffer: key-based remount guarantees
    // a new `CellBuffer` instance on switch (no oversharing possible at
    // the object level).
    const mirrors = new Map<SessionId, SessionMirrorEntry>([
      [ID_A, makeSessionMirror({ sessionId: ID_A, contents: ['alpha'] })],
      [ID_B, makeSessionMirror({ sessionId: ID_B, contents: ['bravo'] })],
    ]);
    const ref = createRef<TerminalCanvasHandle>();
    render(<Harness mirrors={mirrors} canvasRef={ref as Ref<TerminalCanvasHandle>} />);
    await flush();
    const bufferA = ref.current!.cellBuffer;
    const sourceRefA = ref.current!.mirrorSource;
    act(() => {
      switchSession(ID_B);
    });
    await flush();
    const bufferB = ref.current!.cellBuffer;
    const sourceRefB = ref.current!.mirrorSource;
    expect(bufferB).not.toBe(bufferA);
    expect(sourceRefB).not.toBe(sourceRefA);
    // And each session's MirrorSource still belongs to that session.
    expect(sourceRefB).toBe(mirrors.get(ID_B)!.source);
  });
});
