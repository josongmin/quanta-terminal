/**
 * `GridMirror` — comprehensive public-surface test battery.
 *
 * Complements the scenario-focused suites in this directory
 * (`apply_delta`, `cursor`, `mode`, `ordering`, `resync`,
 * `storm_threshold`, `synchronized_update`, `hyperlink_lifecycle`,
 * `schema_evolution_forward`) by exercising the surface areas that were
 * previously untouched: the `apply()` router dispatch, getter exhaustion,
 * `dispose()`, the `meta` family (title / bell / clipboard), the
 * `onEpochMismatch` hook, the `applyResyncRowResponse` invariant gates,
 * and the documented-but-unprocessed `scrolls` / `scrollback_appended`
 * fields.
 *
 * Related design:
 *   - ADR 0017 §2 — envelope-ordering invariants.
 *   - `docs/plans/0001-custom-vt-engine-xterm-removal/epic-C-protocol-mirror.md`
 *     §4 (reducer), §4.3 (apply-rest-on-mismatch), §5 (row-resync protocol),
 *     §13.7 (DECSET 2026 150 ms force-flush).
 *   - RFC 0001 §13 — synchronized-update timing budget.
 *
 * NOTE: per the mission brief, no production code is touched. Any suspected
 * bug is left as an `it.skip` with a comment rather than a silent workaround.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CountingTelemetry, GridMirror } from '../GridMirror.js';
import type {
  BellRequestedPayload,
  ClipboardRequestPayload,
  GridEventEnvelope,
  HyperlinkAddedPayload,
  HyperlinkRemovedPayload,
  RowDelta,
  ScrollDelta,
  SynchronizedUpdatePayload,
} from '../types.js';
import {
  DEFAULT_SESSION_ID,
  blankSnapshot,
  blankSpan,
  cursorEnv,
  defaultCursor,
  deltaEnv,
  makeEnv,
  modeEnv,
  textSpan,
  titleEnv,
} from './fixtures.js';

/* ------------------------------------------------------------------ */
/*  Local helpers                                                     */
/* ------------------------------------------------------------------ */

function bellEnv(seq: number, epoch = 1): GridEventEnvelope<BellRequestedPayload> {
  return makeEnv<BellRequestedPayload>(
    { kind: 'bell_requested' },
    { sequence_no: seq, grid_epoch: epoch },
  );
}

function clipboardEnv(seq: number, epoch = 1): GridEventEnvelope<ClipboardRequestPayload> {
  return makeEnv<ClipboardRequestPayload>(
    { kind: 'clipboard_request', selection: 'clipboard', op: { op: 'query' } },
    { sequence_no: seq, grid_epoch: epoch },
  );
}

function hlAddEnv(
  id: number,
  uri: string,
  seq: number,
  params: string | null = null,
): GridEventEnvelope<HyperlinkAddedPayload> {
  return makeEnv<HyperlinkAddedPayload>(
    { kind: 'hyperlink_added', id, uri, params },
    { sequence_no: seq },
  );
}

function hlRemoveEnv(id: number, seq: number): GridEventEnvelope<HyperlinkRemovedPayload> {
  return makeEnv<HyperlinkRemovedPayload>(
    { kind: 'hyperlink_removed', id },
    { sequence_no: seq },
  );
}

function syncEnv(
  phase: 'begin' | 'end',
  seq: number,
): GridEventEnvelope<SynchronizedUpdatePayload> {
  return makeEnv<SynchronizedUpdatePayload>(
    { kind: 'synchronized_update', phase },
    { sequence_no: seq },
  );
}

function singleRow(
  row: number,
  revBefore: number,
  revAfter: number,
  text: string,
  cols: number,
): RowDelta {
  return {
    row,
    revision_before: revBefore,
    revision_after: revAfter,
    spans: text.length >= cols
      ? [textSpan(text.slice(0, cols), cols)]
      : [textSpan(text, text.length), blankSpan(cols - text.length)],
    continuation: false,
    hyperlink_refs: [],
  };
}

/* ================================================================== */
/*  A.  Router dispatch (apply())                                     */
/* ================================================================== */

describe('GridMirror.apply — router dispatch', () => {
  it('routes grid_snapshot kind through applySnapshot', () => {
    const m = new GridMirror();
    const r = m.apply(blankSnapshot(2, 4, 0, 1));
    expect(r.outcome).toBe('applied');
    expect(m.getDimensions()).toEqual({ rows: 2, cols: 4 });
  });

  it('routes grid_delta kind through applyDelta', () => {
    const m = new GridMirror();
    m.apply(blankSnapshot(2, 4, 0, 1));
    const r = m.apply(deltaEnv([singleRow(0, 1, 2, 'abcd', 4)], { seq: 1 }));
    expect(r.outcome).toBe('applied');
    expect(m.getRow(0)?.cells[0]?.grapheme).toBe('abcd');
  });

  it('routes cursor_moved kind through applyCursor', () => {
    const m = new GridMirror();
    m.apply(blankSnapshot(4, 4, 0, 1));
    m.apply(cursorEnv(defaultCursor(3, 2), { seq: 1 }));
    expect(m.getCursor()).toMatchObject({ row: 3, col: 2 });
  });

  it('routes mode_changed kind through applyMode', () => {
    const m = new GridMirror();
    m.apply(blankSnapshot(2, 4, 0, 1));
    m.apply(modeEnv([{ mode: 'alt_screen', value: true }], { alt_screen: true }, { seq: 1 }));
    expect(m.getMode().alt_screen).toBe(true);
  });

  it('routes title_changed kind through applyMeta', () => {
    const m = new GridMirror();
    m.apply(blankSnapshot(2, 4, 0, 1));
    m.apply(titleEnv('hello', 'both', { seq: 1 }));
    expect(m.getMeta().title).toBe('hello');
  });

  it('routes bell_requested kind as applied (meta-only)', () => {
    const m = new GridMirror();
    m.apply(blankSnapshot(2, 4, 0, 1));
    const r = m.apply(bellEnv(1));
    expect(r.outcome).toBe('applied');
  });

  it('routes hyperlink_added kind through applyMeta', () => {
    const m = new GridMirror();
    m.apply(blankSnapshot(2, 4, 0, 1));
    const r = m.apply(hlAddEnv(7, 'https://a.com', 1));
    expect(r.outcome).toBe('applied');
    expect(m.resolveHyperlink(7).uri).toBe('https://a.com');
  });

  it('routes hyperlink_removed kind through applyMeta', () => {
    const m = new GridMirror();
    m.apply(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(7, 'https://a.com', 1));
    m.apply(hlRemoveEnv(7, 2));
    expect(m.resolveHyperlink(7).uri).toBeNull();
  });

  it('routes clipboard_request kind as applied (advances sequence)', () => {
    const m = new GridMirror();
    m.apply(blankSnapshot(2, 4, 0, 1));
    const r = m.apply(clipboardEnv(1));
    expect(r.outcome).toBe('applied');
    expect(m.getAppliedSequence()).toBe(1n);
  });

  it('routes synchronized_update begin/end through applyMeta', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.apply(blankSnapshot(2, 4, 0, 1));
    onChange.mockClear();
    const rBegin = m.apply(syncEnv('begin', 1));
    const rEnd = m.apply(syncEnv('end', 2));
    expect(rBegin.outcome).toBe('applied');
    expect(rEnd.outcome).toBe('applied');
  });
});

/* ================================================================== */
/*  B.  Snapshot semantics                                            */
/* ================================================================== */

describe('GridMirror.applySnapshot — grid seeding', () => {
  it('accepts a zero-row, zero-col snapshot without throwing', () => {
    const m = new GridMirror();
    const snap = blankSnapshot(0, 0, 0, 1);
    expect(() => m.applySnapshot(snap)).not.toThrow();
    expect(m.getDimensions()).toEqual({ rows: 0, cols: 0 });
    expect(m.getRow(0)).toBeUndefined();
  });

  it('fills missing row_deltas with blank rows so every row is defined', () => {
    const m = new GridMirror();
    const snap = blankSnapshot(4, 4, 0, 1);
    // Drop all row_deltas — every row should still be defined after seed.
    const sparse = {
      ...snap,
      payload: { ...snap.payload, row_deltas: [] as RowDelta[] },
    };
    m.applySnapshot(sparse);
    for (let r = 0; r < 4; r += 1) {
      expect(m.getRow(r)?.cells.length).toBe(4);
      expect(m.getRow(r)?.revision).toBe(0);
    }
  });

  it('a second snapshot at the same epoch with higher sequence replaces the grid', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.applyDelta(deltaEnv([singleRow(0, 1, 2, 'XXXX', 4)], { seq: 1 }));
    expect(m.getRow(0)?.cells[0]?.grapheme).toBe('XXXX');
    m.applySnapshot(blankSnapshot(2, 4, 2, 1));
    // Blank snapshot overwrites the row.
    expect(m.getRow(0)?.cells[0]?.grapheme).toBe('');
    expect(m.getAppliedSequence()).toBe(2n);
  });

  it('stores buffer_kind="alt" when the envelope arrives on the alt buffer', () => {
    const m = new GridMirror();
    const snap = blankSnapshot(2, 4, 0, 1);
    const altSnap = { ...snap, buffer_kind: 'alt' as const };
    m.applySnapshot(altSnap);
    expect(m.getBufferKind()).toBe('alt');
  });

  it('shrinking the grid via a new snapshot drops the old tail rows', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(4, 4, 0, 1));
    expect(m.getDimensions()).toEqual({ rows: 4, cols: 4 });
    m.applySnapshot(blankSnapshot(2, 4, 1, 1));
    expect(m.getDimensions()).toEqual({ rows: 2, cols: 4 });
    // getRow(3) must no longer be defined.
    expect(m.getRow(3)).toBeUndefined();
  });

  it('growing the grid via a new snapshot defines the new rows as blanks', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.applySnapshot(blankSnapshot(5, 4, 1, 1));
    expect(m.getDimensions()).toEqual({ rows: 5, cols: 4 });
    expect(m.getRow(4)?.cells.length).toBe(4);
  });

  it('onEpochMismatch fires only on snapshots whose epoch differs from a PRIOR applied one (not the first)', () => {
    // The initial `epoch = 0` is a placeholder, not an observed epoch, so
    // the first seed at epoch=1 does NOT fire the hook. A subsequent jump
    // to epoch=3 fires once (expected=1, observed=3).
    const onEpochMismatch = vi.fn();
    const m = new GridMirror({ onEpochMismatch });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    expect(onEpochMismatch).not.toHaveBeenCalled();
    m.applySnapshot(blankSnapshot(2, 4, 5, 3));
    expect(onEpochMismatch).toHaveBeenCalledTimes(1);
    expect(onEpochMismatch.mock.calls[0]?.[0]).toEqual({ expected: 1, observed: 3 });
  });

  it('onEpochMismatch does NOT fire for the very first snapshot even when its epoch is non-zero', () => {
    // Regression guard: initial applied-epoch placeholder is 0, but the
    // first real snapshot at epoch=1 must not be reported as a mismatch.
    const onEpochMismatch = vi.fn();
    const m = new GridMirror({ onEpochMismatch });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    expect(onEpochMismatch).not.toHaveBeenCalled();
  });

  it('onEpochMismatch DOES fire when a later snapshot bumps the epoch', () => {
    const onEpochMismatch = vi.fn();
    const m = new GridMirror({ onEpochMismatch });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onEpochMismatch.mockClear();
    m.applySnapshot(blankSnapshot(2, 4, 5, 2));
    expect(onEpochMismatch).toHaveBeenCalledTimes(1);
    expect(onEpochMismatch.mock.calls[0]?.[0]).toEqual({ expected: 1, observed: 2 });
  });

  it('onEpochMismatch does NOT fire for a second snapshot at the same epoch as the applied one', () => {
    const onEpochMismatch = vi.fn();
    const m = new GridMirror({ onEpochMismatch });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onEpochMismatch.mockClear();
    m.applySnapshot(blankSnapshot(2, 4, 1, 1));
    expect(onEpochMismatch).not.toHaveBeenCalled();
  });

  it('a strictly-older-epoch snapshot is discarded with stale_epoch and counter incremented', () => {
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ telemetry });
    m.applySnapshot(blankSnapshot(2, 4, 0, 5));
    const r = m.applySnapshot(blankSnapshot(2, 4, 0, 4));
    expect(r).toEqual({ outcome: 'discarded', reason: 'stale_epoch' });
    expect(telemetry.get('stale_epoch_drop')).toBe(1);
  });
});

/* ================================================================== */
/*  C.  Delta extras: scrolls / scrollback_appended                   */
/* ================================================================== */

describe('GridMirror.applyDelta — additional payload fields', () => {
  it('an empty row_deltas batch with no mismatch is applied but emits no onChange', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onChange.mockClear();
    const r = m.applyDelta(deltaEnv([], { seq: 1 }));
    expect(r.outcome).toBe('applied');
    expect(onChange).not.toHaveBeenCalled();
    expect(m.getAppliedSequence()).toBe(1n);
  });

  it('scrolls field is accepted but currently ignored by the mirror state', () => {
    // Documented gap: EPIC-C mirror does not yet translate ScrollDelta into
    // row rewrites. The event is accepted (no throw, envelope advances seq)
    // but no grid mutation occurs from the scroll op alone.
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(3, 4, 0, 1));
    const scroll: ScrollDelta = { top: 0, bottom: 2, lines: 1 };
    const r = m.applyDelta(deltaEnv([], { seq: 1, scrolls: [scroll] }));
    expect(r.outcome).toBe('applied');
    // Row 0 and row 1 remain blank (no shift performed).
    expect(m.getRow(0)?.cells[0]?.grapheme).toBe('');
    expect(m.getRow(1)?.cells[0]?.grapheme).toBe('');
  });

  it('out-of-range row in a delta triggers row-resync and leaves sequence advanced', () => {
    const onRow = vi.fn();
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ telemetry, onRowResyncRequested: onRow });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const oob: RowDelta = {
      // rowCount is 2 — row 5 is out of range.
      row: 5,
      revision_before: 0,
      revision_after: 1,
      spans: [blankSpan(4)],
      continuation: false,
      hyperlink_refs: [],
    };
    const r = m.applyDelta(deltaEnv([oob], { seq: 1 }));
    expect(r.outcome).toBe('resync_requested');
    expect(onRow).toHaveBeenCalledWith(
      expect.objectContaining({ row: 5, grid_epoch: 1 }),
    );
    expect(telemetry.get('revision_mismatch')).toBe(1);
    expect(m.getAppliedSequence()).toBe(1n);
  });

  it('a mixed batch (one applied, one out-of-range) reports applied outcome', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const r = m.applyDelta(
      deltaEnv(
        [
          singleRow(0, 1, 2, 'abcd', 4),
          {
            row: 99,
            revision_before: 0,
            revision_after: 1,
            spans: [blankSpan(4)],
            continuation: false,
            hyperlink_refs: [],
          },
        ],
        { seq: 1 },
      ),
    );
    expect(r.outcome).toBe('applied');
    expect(m.getRow(0)?.cells[0]?.grapheme).toBe('abcd');
  });

  it('a multi-row clean delta produces a single onChange with all dirty rows', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(4, 4, 0, 1));
    onChange.mockClear();
    m.applyDelta(
      deltaEnv(
        [
          singleRow(0, 1, 2, 'AAAA', 4),
          singleRow(1, 1, 2, 'BBBB', 4),
          singleRow(3, 1, 2, 'DDDD', 4),
        ],
        { seq: 1 },
      ),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    const dirty = onChange.mock.calls[0]?.[0] as ReadonlySet<number>;
    expect(new Set(dirty)).toEqual(new Set([0, 1, 3]));
  });
});

/* ================================================================== */
/*  D.  Row-resync response — epoch / resize_generation gates         */
/* ================================================================== */

describe('GridMirror.applyResyncRowResponse — invariant gates', () => {
  it('applies an Ok response at the current epoch and emits onChange for that single row', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onChange.mockClear();
    const r = m.applyResyncRowResponse({
      status: 'ok',
      grid_epoch: 1,
      resize_generation: 0,
      sequence_no: 2,
      row_delta: singleRow(1, 0, 9, 'zzzz', 4),
    });
    expect(r.outcome).toBe('applied');
    expect(m.getRow(1)?.cells[0]?.grapheme).toBe('zzzz');
    const dirty = onChange.mock.calls[0]?.[0] as ReadonlySet<number>;
    expect(new Set(dirty)).toEqual(new Set([1]));
  });

  it('discards an Ok response at a stale epoch and increments stale_epoch_drop', () => {
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ telemetry });
    m.applySnapshot(blankSnapshot(2, 4, 0, 5));
    const r = m.applyResyncRowResponse({
      status: 'ok',
      grid_epoch: 3,
      resize_generation: 0,
      sequence_no: 1,
      row_delta: singleRow(0, 0, 2, 'xxxx', 4),
    });
    expect(r).toEqual({ outcome: 'discarded', reason: 'stale_epoch' });
    expect(telemetry.get('stale_epoch_drop')).toBe(1);
  });

  it('discards an Ok response at a stale resize_generation', () => {
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ telemetry });
    m.applySnapshot({
      ...blankSnapshot(2, 4, 0, 1),
      resize_generation: 7,
    });
    const r = m.applyResyncRowResponse({
      status: 'ok',
      grid_epoch: 1,
      resize_generation: 6,
      sequence_no: 1,
      row_delta: singleRow(0, 0, 2, 'xxxx', 4),
    });
    expect(r).toEqual({ outcome: 'discarded', reason: 'stale_resize_generation' });
    expect(telemetry.get('stale_resize_generation_drop')).toBe(1);
  });

  it('an Ok response rewrites the row authoritatively regardless of revision_before', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    // Send an Ok row whose revision_before is nonsense — it must still apply.
    m.applyResyncRowResponse({
      status: 'ok',
      grid_epoch: 1,
      resize_generation: 0,
      sequence_no: 1,
      row_delta: {
        row: 0,
        revision_before: 9999,
        revision_after: 42,
        spans: [textSpan('auth', 4)],
        continuation: false,
        hyperlink_refs: [],
      },
    });
    expect(m.getRow(0)?.cells[0]?.grapheme).toBe('auth');
    expect(m.getRow(0)?.revision).toBe(42);
  });

  it('a replay_failed response emits a SnapshotRequest and enters awaiting_snapshot', () => {
    const onSnapshot = vi.fn();
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ onSnapshotResyncRequested: onSnapshot, telemetry });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const r = m.applyResyncRowResponse({
      status: 'replay_failed',
      reason: 'session_gone',
      current_epoch: 1,
      current_resize_generation: 0,
    });
    expect(r.outcome).toBe('snapshot_requested');
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0]?.[0]).toMatchObject({
      reason: 'replay_failed',
      epoch: 1,
    });
    expect(telemetry.get('snapshot_fallback')).toBe(1);
    // Subsequent deltas are now locked out until a snapshot reseeds.
    const next = m.applyDelta(deltaEnv([], { seq: 1 }));
    expect(next.outcome).toBe('discarded');
  });
});

/* ================================================================== */
/*  E.  Getter surface                                                */
/* ================================================================== */

describe('GridMirror — getters', () => {
  it('getRow returns undefined for out-of-range indices (negative and past end)', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(3, 4, 0, 1));
    expect(m.getRow(-1)).toBeUndefined();
    expect(m.getRow(3)).toBeUndefined();
    expect(m.getRow(99)).toBeUndefined();
  });

  it('getDimensions is {0,0} before any snapshot is applied', () => {
    const m = new GridMirror();
    expect(m.getDimensions()).toEqual({ rows: 0, cols: 0 });
  });

  it('getBufferKind defaults to "main" before any event is applied', () => {
    const m = new GridMirror();
    expect(m.getBufferKind()).toBe('main');
  });

  it('getAppliedEpoch / getAppliedSequence are 0n prior to any envelope', () => {
    const m = new GridMirror();
    expect(m.getAppliedEpoch()).toBe(0n);
    expect(m.getAppliedSequence()).toBe(0n);
  });

  it('getCursor reflects the cursor field of the most recent snapshot', () => {
    const m = new GridMirror();
    const snap = blankSnapshot(2, 4, 0, 1);
    const withCursor = {
      ...snap,
      payload: { ...snap.payload, cursor: defaultCursor(1, 2) },
    };
    m.applySnapshot(withCursor);
    expect(m.getCursor()).toMatchObject({ row: 1, col: 2 });
  });

  it('getCursor is unchanged when a snapshot carries cursor=null', () => {
    const m = new GridMirror();
    m.applySnapshot({
      ...blankSnapshot(2, 4, 0, 1),
      payload: { ...blankSnapshot(2, 4, 0, 1).payload, cursor: null },
    });
    // Default cursor state is the class default — row/col 0 with visible=true.
    expect(m.getCursor()).toMatchObject({ row: 0, col: 0, visible: true });
  });

  it('getMeta reflects a prior title_changed event', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(titleEnv('Quanta', 'both', { seq: 1 }));
    expect(m.getMeta().title).toBe('Quanta');
  });

  it('resolveHyperlink returns a safe fallback for an unknown id', () => {
    const m = new GridMirror();
    expect(m.resolveHyperlink(42)).toEqual({ id: 42, uri: null, params: null });
  });

  it('resolveHyperlink returns the latest uri after a re-add of the same id', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(1, 'https://first.com', 1, 'first-params'));
    m.apply(hlAddEnv(1, 'https://second.com', 2, 'second-params'));
    expect(m.resolveHyperlink(1)).toEqual({
      id: 1,
      uri: 'https://second.com',
      params: 'second-params',
    });
  });

  it('snapshotMode returns a deep-frozen shallow clone (no mutation possible)', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.applyMode(modeEnv([{ mode: 'alt_screen', value: true }], { alt_screen: true }, { seq: 1 }));
    const snap = m.snapshotMode();
    expect(snap.alt_screen).toBe(true);
    expect(Object.isFrozen(snap)).toBe(true);
  });
});

/* ================================================================== */
/*  F.  onChange callback semantics                                   */
/* ================================================================== */

describe('GridMirror — onChange callback', () => {
  it('does not crash when no onChange handler is registered', () => {
    const m = new GridMirror();
    expect(() =>
      m.applyDelta(deltaEnv([singleRow(0, 0, 1, 'x', 4)], { seq: 0 })),
    ).not.toThrow();
  });

  it('snapshot reseed fires onChange with every row index present', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(3, 4, 0, 1));
    expect(onChange).toHaveBeenCalledTimes(1);
    const dirty = onChange.mock.calls[0]?.[0] as ReadonlySet<number>;
    expect(new Set(dirty)).toEqual(new Set([0, 1, 2]));
  });

  it('two consecutive deltas produce two separate onChange calls (no coalescing outside a sync window)', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(3, 4, 0, 1));
    onChange.mockClear();
    m.applyDelta(deltaEnv([singleRow(0, 1, 2, 'A', 4)], { seq: 1 }));
    m.applyDelta(deltaEnv([singleRow(1, 1, 2, 'B', 4)], { seq: 2 }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('a delta whose rows are all mismatched does NOT fire onChange', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onChange.mockClear();
    m.applyDelta(
      deltaEnv(
        [{
          row: 0,
          revision_before: 999,
          revision_after: 1000,
          spans: [textSpan('XXXX', 4)],
          continuation: false,
          hyperlink_refs: [],
        }],
        { seq: 1 },
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('onChange is passed a Set instance (duck-typed — has a .size numeric property)', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const dirty = onChange.mock.calls[0]?.[0] as unknown as { size: number };
    expect(typeof dirty.size).toBe('number');
    expect(dirty.size).toBe(2);
  });
});

/* ================================================================== */
/*  G.  Synchronized-update window — accumulation + reset             */
/* ================================================================== */

describe('GridMirror — synchronized update window (DECSET 2026)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a second Begin inside an open window is a no-op (does not restart the timer)', () => {
    // Per synchronized-update.ts begin() early-returns if already open.
    const onChange = vi.fn();
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ onChange, telemetry });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onChange.mockClear();
    m.apply(syncEnv('begin', 1));
    vi.advanceTimersByTime(100);
    m.apply(syncEnv('begin', 2)); // second Begin — should NOT re-arm
    vi.advanceTimersByTime(60);
    // The original timer fires at t=150ms, so by t=160 we've force-ended once.
    expect(telemetry.get('synchronized_update_timeouts')).toBe(1);
  });

  it('a lone End with no open window does nothing (no onChange, no throw)', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onChange.mockClear();
    expect(() => m.apply(syncEnv('end', 1))).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('inside a sync window, duplicate dirty rows across deltas coalesce', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onChange.mockClear();
    m.apply(syncEnv('begin', 1));
    // Two deltas that both dirty row 0 — should dedupe to a single entry.
    m.applyDelta(deltaEnv([singleRow(0, 1, 2, 'A', 4)], { seq: 2 }));
    m.applyDelta(deltaEnv([singleRow(0, 2, 3, 'B', 4)], { seq: 3 }));
    expect(onChange).not.toHaveBeenCalled();
    m.apply(syncEnv('end', 4));
    expect(onChange).toHaveBeenCalledTimes(1);
    const dirty = onChange.mock.calls[0]?.[0] as ReadonlySet<number>;
    expect(new Set(dirty)).toEqual(new Set([0]));
  });

  it('custom syncUpdateTimeoutMs is honored by the force-flush timer', () => {
    const onChange = vi.fn();
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ onChange, telemetry, syncUpdateTimeoutMs: 50 });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onChange.mockClear();
    m.apply(syncEnv('begin', 1));
    m.applyDelta(deltaEnv([singleRow(0, 1, 2, 'A', 4)], { seq: 2 }));
    vi.advanceTimersByTime(49);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(telemetry.get('synchronized_update_timeouts')).toBe(1);
  });

  it('snapshot reseed inside a sync window clears the accumulator without re-flushing the stale set', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(syncEnv('begin', 1));
    m.applyDelta(deltaEnv([singleRow(0, 1, 2, 'x', 4)], { seq: 2 }));
    onChange.mockClear();
    // Snapshot reseeds the mirror and resets the sync window.
    m.applySnapshot(blankSnapshot(3, 4, 3, 1));
    // Exactly one onChange (from the snapshot itself). The pre-snapshot
    // accumulated set is discarded — not flushed on top.
    expect(onChange).toHaveBeenCalledTimes(1);
    const dirty = onChange.mock.calls[0]?.[0] as ReadonlySet<number>;
    expect(dirty.size).toBe(3);
  });
});

/* ================================================================== */
/*  H.  Hyperlink refcount                                            */
/* ================================================================== */

describe('GridMirror — hyperlink refcount', () => {
  it('two adds followed by one remove keeps the entry alive (refcount stays > 0)', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(5, 'https://a.com', 1));
    m.apply(hlAddEnv(5, 'https://b.com', 2)); // refcount=2, uri updated
    m.apply(hlRemoveEnv(5, 3));                // refcount=1 — entry survives
    expect(m.resolveHyperlink(5).uri).toBe('https://b.com');
  });

  it('removing an unknown hyperlink id is a no-op (no throw)', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    expect(() => m.apply(hlRemoveEnv(999, 1))).not.toThrow();
    expect(m.resolveHyperlink(999).uri).toBeNull();
  });

  it('hyperlink table survives a same-epoch delta-only stream', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(1, 'https://stable.com', 1));
    m.applyDelta(deltaEnv([singleRow(0, 1, 2, 'abcd', 4)], { seq: 2 }));
    m.applyDelta(deltaEnv([singleRow(1, 1, 2, 'efgh', 4)], { seq: 3 }));
    expect(m.resolveHyperlink(1).uri).toBe('https://stable.com');
  });
});

/* ================================================================== */
/*  I.  Buffer-kind propagation                                       */
/* ================================================================== */

describe('GridMirror — buffer_kind propagation', () => {
  it('cursor_moved on alt buffer flips getBufferKind to "alt"', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    expect(m.getBufferKind()).toBe('main');
    m.apply(cursorEnv(defaultCursor(0, 0), { seq: 1, buffer_kind: 'alt' }));
    expect(m.getBufferKind()).toBe('alt');
  });

  it('a main-buffer snapshot after an alt-buffer cursor flips back to "main"', () => {
    const m = new GridMirror();
    m.applySnapshot({ ...blankSnapshot(2, 4, 0, 1), buffer_kind: 'alt' });
    expect(m.getBufferKind()).toBe('alt');
    m.applySnapshot(blankSnapshot(2, 4, 1, 1));
    expect(m.getBufferKind()).toBe('main');
  });
});

/* ================================================================== */
/*  J.  dispose() and _mismatchLogLength                              */
/* ================================================================== */

describe('GridMirror — teardown + internal hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispose() after an open sync window cancels the force-flush timer', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    onChange.mockClear();
    m.apply(syncEnv('begin', 1));
    m.applyDelta(deltaEnv([singleRow(0, 1, 2, 'A', 4)], { seq: 2 }));
    m.dispose();
    vi.advanceTimersByTime(500);
    // Timer was cancelled — no timeout flush.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('_mismatchLogLength grows with each unhandled mismatch and resets on snapshot reseed', () => {
    const m = new GridMirror({ stormThreshold: { k: 10, windowMs: 10_000 } });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    expect(m._mismatchLogLength()).toBe(0);
    // Force a revision mismatch.
    m.applyDelta(
      deltaEnv(
        [{
          row: 0,
          revision_before: 99,
          revision_after: 100,
          spans: [textSpan('X', 4)],
          continuation: false,
          hyperlink_refs: [],
        }],
        { seq: 1 },
      ),
    );
    expect(m._mismatchLogLength()).toBe(1);
    // Snapshot reseed clears it.
    m.applySnapshot(blankSnapshot(2, 4, 2, 1));
    expect(m._mismatchLogLength()).toBe(0);
  });
});

/* ================================================================== */
/*  K.  Session-id passthrough on resync requests                     */
/* ================================================================== */

describe('GridMirror — resync-request session_id plumbing', () => {
  it('RowResyncRequest carries the triggering envelope session_id', () => {
    const onRow = vi.fn();
    const m = new GridMirror({ onRowResyncRequested: onRow });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const env = deltaEnv(
      [{
        row: 0,
        revision_before: 999,
        revision_after: 1000,
        spans: [textSpan('X', 4)],
        continuation: false,
        hyperlink_refs: [],
      }],
      { seq: 1 },
    );
    // sanity — fixtures use DEFAULT_SESSION_ID.
    expect(env.session_id).toBe(DEFAULT_SESSION_ID);
    m.applyDelta(env);
    expect(onRow.mock.calls[0]?.[0]).toMatchObject({ session_id: DEFAULT_SESSION_ID });
  });

  it('SnapshotResyncRequest on epoch-advance carries the triggering envelope session_id', () => {
    const onSnap = vi.fn();
    const m = new GridMirror({ onSnapshotResyncRequested: onSnap });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const env = deltaEnv([], { seq: 10, epoch: 3 });
    m.applyDelta(env);
    expect(onSnap.mock.calls[0]?.[0]).toMatchObject({
      session_id: env.session_id,
      epoch: 3,
      reason: 'epoch_advanced_without_snapshot',
    });
  });
});
