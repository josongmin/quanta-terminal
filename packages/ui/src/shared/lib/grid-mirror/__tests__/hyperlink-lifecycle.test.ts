/**
 * `GridMirror` — OSC 8 hyperlink lifecycle edge cases.
 *
 * Focuses on depth cases NOT already exercised by:
 *   - `GridMirror.test.ts` §A (router wiring), §E (basic resolve + re-add),
 *     §H (refcount survival + unknown-id no-op + delta-stream survival).
 *   - `hyperlink_lifecycle.e2e.test.ts` (open → reference → close orphan
 *     fallback; id-reuse after remove with a fresh-URI row).
 *
 * Scenarios covered here:
 *   1. OSC 8 `params` passthrough (non-null, null-default, update-on-re-add).
 *   2. Empty-URI add is accepted and round-trips as `''` (distinct from null).
 *   3. Refcount decay through N adds / N removes — entry only evicts at 0.
 *   4. Cell referencing a hyperlink_id absent from the table resolves to
 *      a null uri without throwing (graceful resolver fallback).
 *   5. `resolveHyperlink(0)` — the "no link" sentinel — resolves to null.
 *   6. Boundary id values (`2^31 - 1`) round-trip intact.
 *   7. Stale-sequence / stale-epoch gates on `hyperlink_added` —
 *      discarded envelopes must NOT mutate the table.
 *   8. Hyperlink table persists across a row-resync OK response.
 *   9. Snapshot reseed — current policy observation (the mirror does NOT
 *      clear the hyperlink table on reseed). Flagged as a possible
 *      production gap in the final report.
 *  10. Batched add → remove → add at ascending sequences yields the
 *      latest URI.
 *
 * No production code is modified; all assertions target public surface.
 */

import { describe, expect, it } from 'vitest';

import { GridMirror } from '../GridMirror.js';
import type {
  GridEventEnvelope,
  HyperlinkAddedPayload,
  HyperlinkRemovedPayload,
  RowDelta,
} from '../types.js';
import { blankSnapshot, blankSpan, deltaEnv, makeEnv } from './fixtures.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function hlAddEnv(
  id: number,
  uri: string,
  seq: number,
  params: string | null = null,
  epoch = 1,
): GridEventEnvelope<HyperlinkAddedPayload> {
  return makeEnv<HyperlinkAddedPayload>(
    { kind: 'hyperlink_added', id, uri, params },
    { sequence_no: seq, grid_epoch: epoch },
  );
}

function hlAddEnvNoParams(
  id: number,
  uri: string,
  seq: number,
): GridEventEnvelope<HyperlinkAddedPayload> {
  // Construct without a `params` field at all (the wire marks it optional).
  return makeEnv<HyperlinkAddedPayload>(
    { kind: 'hyperlink_added', id, uri },
    { sequence_no: seq },
  );
}

function hlRemoveEnv(
  id: number,
  seq: number,
  epoch = 1,
): GridEventEnvelope<HyperlinkRemovedPayload> {
  return makeEnv<HyperlinkRemovedPayload>(
    { kind: 'hyperlink_removed', id },
    { sequence_no: seq, grid_epoch: epoch },
  );
}

function rowWithLink(
  row: number,
  revBefore: number,
  revAfter: number,
  hyperlinkId: number,
  cols: number,
): RowDelta {
  return {
    row,
    revision_before: revBefore,
    revision_after: revAfter,
    spans: [
      {
        cols: 2,
        sgr: '0x0000000000000000',
        graphemes: { utf8: 'ab' },
        hyperlink_id: hyperlinkId,
        ext: null,
      },
      blankSpan(cols - 2),
    ],
    continuation: false,
    hyperlink_refs: [hyperlinkId],
  };
}

/* ================================================================== */
/*  1. OSC 8 params passthrough                                        */
/* ================================================================== */

describe('hyperlink params passthrough', () => {
  it('resolve exposes the OSC 8 params string supplied on add', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(10, 'https://example.com', 1, 'id=42;foo=bar'));
    expect(m.resolveHyperlink(10).params).toBe('id=42;foo=bar');
  });

  it('resolve exposes params=null when the add payload omits the field', () => {
    // Wire docs mark `params` optional; an absent field must normalise to null.
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnvNoParams(11, 'https://example.com', 1));
    expect(m.resolveHyperlink(11).params).toBeNull();
  });

  it('a re-add of an existing id updates params alongside uri', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(12, 'https://first.com', 1, 'id=1'));
    m.apply(hlAddEnv(12, 'https://second.com', 2, 'id=2'));
    expect(m.resolveHyperlink(12)).toEqual({
      id: 12,
      uri: 'https://second.com',
      params: 'id=2',
    });
  });
});

/* ================================================================== */
/*  2. Empty URI round-trip                                            */
/* ================================================================== */

describe('hyperlink empty-string uri', () => {
  it('an add with uri="" is accepted and resolve returns "" (not null)', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(20, '', 1));
    const resolved = m.resolveHyperlink(20);
    expect(resolved.uri).toBe('');
    // null is the unknown-id sentinel — '' must remain distinct from null.
    expect(resolved.uri).not.toBeNull();
  });
});

/* ================================================================== */
/*  3. Refcount decay through N adds / N removes                       */
/* ================================================================== */

describe('hyperlink refcount decay', () => {
  it('three adds then three removes evicts the entry only at the final remove', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(30, 'https://a', 1));
    m.apply(hlAddEnv(30, 'https://b', 2));
    m.apply(hlAddEnv(30, 'https://c', 3));
    // refcount == 3, latest URI c.
    m.apply(hlRemoveEnv(30, 4));
    expect(m.resolveHyperlink(30).uri).toBe('https://c');
    m.apply(hlRemoveEnv(30, 5));
    expect(m.resolveHyperlink(30).uri).toBe('https://c');
    m.apply(hlRemoveEnv(30, 6));
    // Final decrement evicts.
    expect(m.resolveHyperlink(30).uri).toBeNull();
  });

  it('a single add + single remove evicts immediately (refcount 1 → 0)', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(31, 'https://solo', 1));
    m.apply(hlRemoveEnv(31, 2));
    expect(m.resolveHyperlink(31)).toEqual({ id: 31, uri: null, params: null });
  });
});

/* ================================================================== */
/*  4. Row cell referencing an absent table entry                      */
/* ================================================================== */

describe('hyperlink table vs row-cell refs', () => {
  it('a cell pointing at an id with no table entry resolves to null without throwing', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 8, 0, 1));
    // Write a row whose cell refs id=77, but never send the HyperlinkAdded.
    m.applyDelta(deltaEnv([rowWithLink(0, 1, 2, 77, 8)], { seq: 1 }));
    expect(m.getRow(0)?.cells[0]?.hyperlink_id).toBe(77);
    expect(() => m.resolveHyperlink(77)).not.toThrow();
    expect(m.resolveHyperlink(77)).toEqual({ id: 77, uri: null, params: null });
  });

  it('resolveHyperlink(0) — the "no link" sentinel — returns null', () => {
    // hyperlink_id=0 is conventionally "no hyperlink". Resolver must not
    // throw or accidentally alias to some other entry.
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    expect(m.resolveHyperlink(0)).toEqual({ id: 0, uri: null, params: null });
  });
});

/* ================================================================== */
/*  5. Boundary id values                                              */
/* ================================================================== */

describe('hyperlink boundary ids', () => {
  it('id = 2^31 - 1 round-trips through add + resolve intact', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const big = 2 ** 31 - 1;
    m.apply(hlAddEnv(big, 'https://edge', 1, 'p=max'));
    expect(m.resolveHyperlink(big)).toEqual({
      id: big,
      uri: 'https://edge',
      params: 'p=max',
    });
  });
});

/* ================================================================== */
/*  6. Gate invariants on hyperlink_added                              */
/* ================================================================== */

describe('hyperlink_added envelope gating', () => {
  it('a stale-sequence hyperlink_added is discarded and leaves the table untouched', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(40, 'https://kept', 5));
    // Now send an older sequence trying to overwrite the entry.
    const stale = m.apply(hlAddEnv(40, 'https://lost', 3));
    expect(stale).toEqual({ outcome: 'discarded', reason: 'stale_sequence' });
    expect(m.resolveHyperlink(40).uri).toBe('https://kept');
  });

  it('a hyperlink_added at a future epoch triggers snapshot_requested and leaves table unchanged', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(41, 'https://kept', 1));
    const r = m.apply(hlAddEnv(41, 'https://future', 10, null, 2));
    expect(r.outcome).toBe('snapshot_requested');
    // Entry must remain as-last-applied under epoch=1.
    expect(m.resolveHyperlink(41).uri).toBe('https://kept');
  });

  it('a hyperlink_removed at a strictly-older epoch is discarded with stale_epoch', () => {
    const m = new GridMirror();
    // Seed at epoch=3 so we can send a remove at epoch=2.
    m.applySnapshot(blankSnapshot(2, 4, 0, 3));
    m.apply(hlAddEnv(42, 'https://kept', 1, null, 3));
    const r = m.apply(hlRemoveEnv(42, 2, 2));
    expect(r).toEqual({ outcome: 'discarded', reason: 'stale_epoch' });
    expect(m.resolveHyperlink(42).uri).toBe('https://kept');
  });
});

/* ================================================================== */
/*  7. Persistence across a row-resync OK response                     */
/* ================================================================== */

describe('hyperlink table survives row-resync', () => {
  it('table entries persist across an applyResyncRowResponse authoritative row rewrite', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 8, 0, 1));
    m.apply(hlAddEnv(50, 'https://persistent', 1));
    // Authoritative row replace — explicitly unrelated to hyperlink state.
    m.applyResyncRowResponse({
      status: 'ok',
      grid_epoch: 1,
      resize_generation: 0,
      sequence_no: 5,
      row_delta: rowWithLink(0, 0, 9, 50, 8),
    });
    expect(m.getRow(0)?.cells[0]?.hyperlink_id).toBe(50);
    expect(m.resolveHyperlink(50).uri).toBe('https://persistent');
  });
});

/* ================================================================== */
/*  8. Snapshot reseed — current policy observation                    */
/* ================================================================== */

describe('hyperlink table across snapshot reseed', () => {
  it('a same-epoch snapshot reseed currently retains previously-added hyperlinks', () => {
    // Observation test: applySnapshot does NOT clear the hyperlink table in
    // the current implementation. If the product policy is "snapshots are
    // authoritative and reseed everything including hyperlinks" then this
    // test would fail and flag the fix. Today it passes — see findings.
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(60, 'https://pre-reseed', 1));
    m.applySnapshot(blankSnapshot(2, 4, 2, 1));
    expect(m.resolveHyperlink(60).uri).toBe('https://pre-reseed');
  });

  it('a new-epoch snapshot reseed currently retains previously-added hyperlinks', () => {
    // Same observation across an epoch bump — the hyperlink table is not
    // epoch-scoped in the current mirror.
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(61, 'https://old-epoch', 1));
    m.applySnapshot(blankSnapshot(2, 4, 0, 2));
    expect(m.resolveHyperlink(61).uri).toBe('https://old-epoch');
  });
});

/* ================================================================== */
/*  9. Ordered add → remove → add within an ascending sequence stream  */
/* ================================================================== */

describe('hyperlink ordered add/remove/add stream', () => {
  it('add → remove (evict) → add at ascending seqs ends on the new URI', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.apply(hlAddEnv(70, 'https://v1', 1));
    m.apply(hlRemoveEnv(70, 2)); // refcount 1 → 0 → evicted
    m.apply(hlAddEnv(70, 'https://v2', 3, 'x=2'));
    expect(m.resolveHyperlink(70)).toEqual({
      id: 70,
      uri: 'https://v2',
      params: 'x=2',
    });
  });
});
