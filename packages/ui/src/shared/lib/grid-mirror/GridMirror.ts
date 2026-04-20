/**
 * `GridMirror` — the UI-side reducer that applies ordered wire events from
 * the VT engine into a renderer-facing row/cursor/mode model.
 *
 * See `docs/plans/0001-custom-vt-engine-xterm-removal/epic-C-protocol-mirror.md`
 * §4 for the full design. Key invariants:
 *
 * - **Ordering (ADR 0017 §2)**: envelopes with `grid_epoch < state.epoch`
 *   are discarded; `GridDelta` envelopes with
 *   `resize_generation < state.resize_generation` are discarded; non-snapshot
 *   envelopes with `sequence_no <= state.applied_sequence` are discarded.
 * - **Snapshot authority**: a `grid_snapshot` at any epoch/sequence reseeds
 *   the mirror. It is the only payload accepted when the incoming epoch is
 *   higher than the applied epoch.
 * - **Row-revision recovery**: when `RowDelta.revision_before` mismatches
 *   `state.rowRevisions[row]`, the mirror emits a `ResyncRowRequest` via
 *   `onRowResyncRequested` and continues applying other rows in the same
 *   delta (apply-rest-on-mismatch per §4.3).
 * - **Storm fallback**: ≥ K mismatches within W ms escalates to a full
 *   `SnapshotRequest` via `onSnapshotResyncRequested`.
 * - **Synchronized update (DECSET 2026)**: Begin → suppress `onChange`;
 *   End (or 150ms timeout) → fire `onChange` with the accumulated dirty set.
 */

import { SyncUpdateWindow } from './synchronized-update.js';
import type {
  ApplyResult,
  BufferKind,
  Cell,
  CursorState,
  GridDeltaPayload,
  GridEventEnvelope,
  GridMeta,
  GridPayload,
  GridSnapshotPayload,
  MirrorCounterName,
  MirrorTelemetry,
  ModeChange,
  ResyncRowRequest,
  Row,
  RowDelta,
  SnapshotRequest,
  TerminalModeState,
} from './types.js';

const DEFAULT_STORM_K = 5;
const DEFAULT_STORM_WINDOW_MS = 10_000;
const SYNC_UPDATE_TIMEOUT_MS = 150;

export interface GridMirrorOptions {
  readonly telemetry?: MirrorTelemetry;
  /** Storm detector. Defaults: K=5 mismatches within W=10 000 ms. */
  readonly stormThreshold?: { readonly k: number; readonly windowMs: number };
  /** Synchronized-update force-flush timeout. Default 150 ms. */
  readonly syncUpdateTimeoutMs?: number;
  /** Injected `now()` for deterministic tests. */
  readonly now?: () => number;
  readonly onChange?: (dirtyRows: ReadonlySet<number>) => void;
  readonly onRowResyncRequested?: (req: ResyncRowRequest) => void;
  readonly onSnapshotResyncRequested?: (req: SnapshotRequest) => void;
  readonly onEpochMismatch?: (info: { expected: number; observed: number }) => void;
}

/** Row-resync response variants, mirror-side. See plan §5.2. */
export type ResyncRowResponse =
  | {
      readonly status: 'ok';
      readonly grid_epoch: number;
      readonly resize_generation: number;
      readonly sequence_no: number;
      readonly row_delta: RowDelta;
    }
  | {
      readonly status: 'replay_failed';
      readonly reason:
        | 'epoch_changed'
        | 'resize_generation_changed'
        | 'row_out_of_range'
        | 'session_gone';
      readonly current_epoch: number;
      readonly current_resize_generation: number;
    };

export class GridMirror {
  /* eslint-disable @typescript-eslint/prefer-readonly -- mutated on apply */
  private epoch = 0;
  /**
   * True once at least one `grid_snapshot` has been applied. The initial
   * `epoch = 0` is a default placeholder, not an observed epoch, so the
   * `onEpochMismatch` hook must NOT fire for the very first snapshot even
   * when its `grid_epoch !== 0`. Public getter `getAppliedEpoch()` still
   * returns `0n` pre-apply (consumer contract, docs/plans §DoD-C-22).
   */
  private hasAppliedSnapshot = false;
  private appliedSequence = 0;
  private resizeGeneration = 0;
  private rowCount = 0;
  private colCount = 0;
  private rows: Row[] = [];
  private rowRevisions: Uint32Array = new Uint32Array(0);
  /** Monotonic counter of rows appended to scrollback since the mirror was
   *  seeded. Bumped by `grid_delta.scrollback_appended` on the main buffer. */
  private scrollbackAppendedTotal = 0;
  private cursor: CursorState = {
    row: 0,
    col: 0,
    visible: true,
    shape: 'block',
    blinking: true,
    pending_wrap: false,
  };
  private mode: TerminalModeState = {};
  private meta: GridMeta = {};
  private bufferKind: BufferKind = 'main';
  private hyperlinks = new Map<number, { uri: string; params: string | null; refcount: number }>();
  /** Sliding window of mismatch timestamps (ms). */
  private mismatchLog: number[] = [];
  private awaitingSnapshot = false;
  /* eslint-enable @typescript-eslint/prefer-readonly */

  private readonly stormK: number;
  private readonly stormWindowMs: number;
  private readonly syncWindow: SyncUpdateWindow;
  private readonly telemetry: MirrorTelemetry;
  private readonly nowFn: () => number;
  private readonly onChangeFn: ((dirty: ReadonlySet<number>) => void) | undefined;
  private readonly onRowResyncFn: ((r: ResyncRowRequest) => void) | undefined;
  private readonly onSnapshotResyncFn: ((r: SnapshotRequest) => void) | undefined;
  private readonly onEpochMismatchFn:
    | ((info: { expected: number; observed: number }) => void)
    | undefined;

  constructor(opts: GridMirrorOptions = {}) {
    this.stormK = opts.stormThreshold?.k ?? DEFAULT_STORM_K;
    this.stormWindowMs = opts.stormThreshold?.windowMs ?? DEFAULT_STORM_WINDOW_MS;
    this.telemetry = opts.telemetry ?? noopTelemetry();
    this.nowFn = opts.now ?? (() => Date.now());
    this.onChangeFn = opts.onChange;
    this.onRowResyncFn = opts.onRowResyncRequested;
    this.onSnapshotResyncFn = opts.onSnapshotResyncRequested;
    this.onEpochMismatchFn = opts.onEpochMismatch;
    this.syncWindow = new SyncUpdateWindow({
      timeoutMs: opts.syncUpdateTimeoutMs ?? SYNC_UPDATE_TIMEOUT_MS,
      flush: (dirty) => this.onChangeFn?.(dirty),
      onTimeout: () => this.telemetry.incr('synchronized_update_timeouts'),
      now: this.nowFn,
    });
  }

  /* ---------- public getters ---------- */

  getRow(row: number): Row | undefined {
    return this.rows[row];
  }

  getCursor(): Readonly<CursorState> {
    return this.cursor;
  }

  getMode(): Readonly<TerminalModeState> {
    return this.mode;
  }

  /**
   * Deep-frozen shallow clone of the current mode state, consumed by
   * EPIC-E's `ModeSnapshot` so the encoder sees a reducer-snapshot that
   * cannot be mutated mid-encode. See ADR 0017 §4.
   */
  snapshotMode(): Readonly<TerminalModeState> {
    return Object.freeze({ ...this.mode });
  }

  getMeta(): Readonly<GridMeta> {
    return this.meta;
  }

  getDimensions(): { rows: number; cols: number } {
    return { rows: this.rowCount, cols: this.colCount };
  }

  getBufferKind(): BufferKind {
    return this.bufferKind;
  }

  /** Count of rows the engine has appended to scrollback since this mirror
   *  was last seeded by a snapshot. Consumers use this to drive a
   *  scrollback view. */
  getScrollbackAppendedTotal(): number {
    return this.scrollbackAppendedTotal;
  }

  /** Latest applied `sequence_no` within the current epoch (bigint for parity
   *  with the EPIC-E `ModeSnapshot` diagnostic). */
  getAppliedSequence(): bigint {
    return BigInt(this.appliedSequence);
  }

  /** Current `grid_epoch`. */
  getAppliedEpoch(): bigint {
    return BigInt(this.epoch);
  }

  resolveHyperlink(id: number): { id: number; uri: string | null; params: string | null } {
    const entry = this.hyperlinks.get(id);
    if (!entry) return { id, uri: null, params: null };
    return { id, uri: entry.uri, params: entry.params };
  }

  /** @internal — test-only access to the mismatch window length. */
  _mismatchLogLength(): number {
    return this.mismatchLog.length;
  }

  /* ---------- public apply ---------- */

  /** Dispatch a wire envelope by payload kind. */
  apply(env: GridEventEnvelope<GridPayload>): ApplyResult {
    const { payload } = env;
    switch (payload.kind) {
      case 'grid_snapshot':
        return this.applySnapshot({ ...env, payload });
      case 'grid_delta':
        return this.applyDelta({ ...env, payload });
      case 'cursor_moved':
        return this.applyCursor({ ...env, payload });
      case 'mode_changed':
        return this.applyMode({ ...env, payload });
      case 'title_changed':
      case 'bell_requested':
      case 'hyperlink_added':
      case 'hyperlink_removed':
      case 'clipboard_request':
      case 'synchronized_update':
        return this.applyMeta(env as GridEventEnvelope<GridPayload>);
      /* c8 ignore next 3 — unreachable once schema parity holds. */
      default:
        return { outcome: 'discarded', reason: 'unknown_variant' };
    }
  }

  /* ---------- snapshot ---------- */

  applySnapshot(env: GridEventEnvelope<GridSnapshotPayload>): ApplyResult {
    // Snapshots reseed unconditionally: a snapshot at any sequence / epoch
    // is authoritative (see §4.3). A strictly-older epoch is still discarded
    // because that would be replaying the past.
    if (env.grid_epoch < this.epoch) {
      this.telemetry.incr('stale_epoch_drop');
      return { outcome: 'discarded', reason: 'stale_epoch' };
    }
    // Only fire onEpochMismatch when we have previously applied a snapshot
    // and the new epoch differs from the prior applied one. The initial
    // `this.epoch = 0` is a placeholder — not an observed epoch — so the
    // very first snapshot must NOT be reported as a mismatch.
    if (this.hasAppliedSnapshot && env.grid_epoch !== this.epoch) {
      this.onEpochMismatchFn?.({ expected: this.epoch, observed: env.grid_epoch });
    }
    const { payload } = env;
    this.hasAppliedSnapshot = true;
    this.epoch = env.grid_epoch;
    this.appliedSequence = env.sequence_no;
    this.resizeGeneration = env.resize_generation;
    this.bufferKind = env.buffer_kind;
    this.rowCount = payload.rows;
    this.colCount = payload.cols;
    this.rows = new Array<Row>(payload.rows);
    this.rowRevisions = new Uint32Array(payload.rows);
    for (const rd of payload.row_deltas) {
      this.writeRow(rd);
    }
    // Fill any missing rows with a blank row to guarantee `getRow(i)` is defined.
    for (let i = 0; i < payload.rows; i += 1) {
      if (!this.rows[i]) {
        this.rows[i] = blankRow(payload.cols);
      }
    }
    if (payload.cursor) {
      this.cursor = { ...payload.cursor };
    }
    this.mode = { ...payload.mode_state };
    this.meta = { ...(payload.meta ?? {}) };
    // Hyperlink table is part of the authoritative grid state that the
    // snapshot replaces. Leaving stale entries would let a pre-reseed id
    // (from a now-discarded epoch, or a re-used id within the same epoch)
    // resolve after the reseed — misrouting OSC 8 clicks to URIs the engine
    // no longer owns. A snapshot carries its own `hyperlink_refs` inside
    // each row_delta, and the engine will re-emit `hyperlink_added` for any
    // URI that survives the reseed, so clearing here is safe.
    this.hyperlinks.clear();
    // Clear mismatch / resync gating — the mirror is fresh.
    this.mismatchLog = [];
    this.awaitingSnapshot = false;
    this.scrollbackAppendedTotal = 0;
    this.syncWindow.reset();
    this.dispatchChange(new Set(this.rows.map((_, i) => i)));
    return { outcome: 'applied' };
  }

  /* ---------- delta ---------- */

  applyDelta(env: GridEventEnvelope<GridDeltaPayload>): ApplyResult {
    const gate = this.gate(env, 'grid_delta');
    if (gate) return gate;
    const dirty = new Set<number>();
    let anyMismatch = false;
    // Scrolls land BEFORE row deltas per `ScrollDeltaWire` docstring
    // (quanta-proto::events_grid). The engine already bumps row revisions
    // and emits matching row_deltas for every in-region row when it scrolls
    // (`scroll_up_region` marks each touched row in `self.damage` — see
    // crates/quanta-vt/src/domain/grid.rs §scroll_up_region). We therefore
    // treat `scrolls` as a *signal* only: mark the covered row range dirty
    // so a downstream consumer that observes the dirty set still re-renders
    // the shifted region even if row_deltas coverage is sparse. Actual cell
    // movement is NOT performed here — the authoritative content arrives via
    // row_deltas in the same envelope.
    const scrolls = env.payload.scrolls ?? [];
    for (const sd of scrolls) {
      if (this.rowCount === 0) continue;
      const top = Math.max(0, sd.top | 0);
      const bottom = Math.min(this.rowCount - 1, sd.bottom | 0);
      if (top > bottom) continue;
      for (let r = top; r <= bottom; r += 1) dirty.add(r);
    }
    for (const rd of env.payload.row_deltas) {
      if (rd.row >= this.rowCount) {
        // Out-of-range row (we're waiting for a resize snapshot); treat as
        // mismatch and ask for a row resync.
        anyMismatch = true;
        this.recordMismatch(env, rd.row);
        continue;
      }
      const current = this.rowRevisions[rd.row] ?? 0;
      if (rd.revision_before !== current) {
        anyMismatch = true;
        this.recordMismatch(env, rd.row);
        continue;
      }
      this.writeRow(rd);
      dirty.add(rd.row);
    }
    // `scrollback_appended` is main-buffer-only per the wire spec. Accumulate
    // unconditionally — alt-buffer envelopes carry zero because the engine
    // only bumps it in the full-viewport main-buffer branch of
    // `scroll_up_region`.
    const appended = env.payload.scrollback_appended ?? 0;
    if (appended > 0) {
      this.scrollbackAppendedTotal += appended;
    }
    this.appliedSequence = env.sequence_no;
    if (dirty.size > 0) {
      this.dispatchChange(dirty);
    }
    if (this.awaitingSnapshot) {
      return { outcome: 'snapshot_requested' };
    }
    if (anyMismatch && dirty.size === 0) {
      // All rows mismatched; caller gets `resync_requested` as the primary signal.
      return { outcome: 'resync_requested' };
    }
    return { outcome: 'applied' };
  }

  /* ---------- cursor ---------- */

  applyCursor(env: GridEventEnvelope<{ kind: 'cursor_moved'; cursor: CursorState }>): ApplyResult {
    const gate = this.gate(env, 'cursor_moved');
    if (gate) return gate;
    this.cursor = { ...env.payload.cursor };
    this.bufferKind = env.buffer_kind;
    this.appliedSequence = env.sequence_no;
    return { outcome: 'applied' };
  }

  /* ---------- mode ---------- */

  applyMode(
    env: GridEventEnvelope<{
      kind: 'mode_changed';
      changes: readonly ModeChange[];
      state: TerminalModeState;
    }>,
  ): ApplyResult {
    const gate = this.gate(env, 'mode_changed');
    if (gate) return gate;
    this.mode = { ...env.payload.state };
    this.appliedSequence = env.sequence_no;
    return { outcome: 'applied' };
  }

  /* ---------- meta (title/bell/hyperlink/clipboard/sync) ---------- */

  applyMeta(env: GridEventEnvelope<GridPayload>): ApplyResult {
    const { payload } = env;
    switch (payload.kind) {
      case 'title_changed': {
        const gate = this.gate(env, 'title_changed');
        if (gate) return gate;
        this.meta = { ...this.meta, title: payload.title };
        this.appliedSequence = env.sequence_no;
        return { outcome: 'applied' };
      }
      case 'bell_requested': {
        const gate = this.gate(env, 'bell_requested');
        if (gate) return gate;
        this.appliedSequence = env.sequence_no;
        return { outcome: 'applied' };
      }
      case 'hyperlink_added': {
        const gate = this.gate(env, 'hyperlink_added');
        if (gate) return gate;
        const existing = this.hyperlinks.get(payload.id);
        if (existing) {
          existing.uri = payload.uri;
          existing.params = payload.params ?? null;
          existing.refcount += 1;
        } else {
          this.hyperlinks.set(payload.id, {
            uri: payload.uri,
            params: payload.params ?? null,
            refcount: 1,
          });
        }
        this.appliedSequence = env.sequence_no;
        return { outcome: 'applied' };
      }
      case 'hyperlink_removed': {
        const gate = this.gate(env, 'hyperlink_removed');
        if (gate) return gate;
        const entry = this.hyperlinks.get(payload.id);
        if (entry) {
          // Underflow guard: a malformed engine stream could emit more
          // `hyperlink_removed` than `hyperlink_added` (bug, stale replay,
          // or a race during reseed). If we blindly decremented below 0
          // the eviction check below would fire and remove an entry whose
          // live references are still painted on the grid — the next
          // `resolveHyperlink` would then return `null` for a cell that
          // is still visibly linked. Clamp at 0 and only evict once the
          // last live reference is gone.
          if (entry.refcount > 0) {
            entry.refcount -= 1;
          }
          if (entry.refcount <= 0) {
            this.hyperlinks.delete(payload.id);
          }
        }
        this.appliedSequence = env.sequence_no;
        return { outcome: 'applied' };
      }
      case 'clipboard_request': {
        const gate = this.gate(env, 'clipboard_request');
        if (gate) return gate;
        this.appliedSequence = env.sequence_no;
        return { outcome: 'applied' };
      }
      case 'synchronized_update': {
        const gate = this.gate(env, 'synchronized_update');
        if (gate) return gate;
        if (payload.phase === 'begin') {
          this.syncWindow.begin();
        } else {
          this.syncWindow.end();
        }
        this.appliedSequence = env.sequence_no;
        return { outcome: 'applied' };
      }
      /* c8 ignore next 3 — fallthrough guarded by applyDelta/etc. */
      default:
        return { outcome: 'discarded', reason: 'unknown_variant' };
    }
  }

  /* ---------- row-resync response handling ---------- */

  applyResyncRowResponse(resp: ResyncRowResponse): ApplyResult {
    if (resp.status === 'replay_failed') {
      this.telemetry.incr('snapshot_fallback');
      this.awaitingSnapshot = true;
      this.onSnapshotResyncFn?.({
        session_id: '',
        epoch: this.epoch,
        reason: 'replay_failed',
      });
      return { outcome: 'snapshot_requested' };
    }
    if (resp.grid_epoch !== this.epoch) {
      this.telemetry.incr('stale_epoch_drop');
      return { outcome: 'discarded', reason: 'stale_epoch' };
    }
    if (resp.resize_generation !== this.resizeGeneration) {
      this.telemetry.incr('stale_resize_generation_drop');
      return { outcome: 'discarded', reason: 'stale_resize_generation' };
    }
    const row = resp.row_delta.row;
    // Authoritative row replacement — ignore revision_before.
    this.writeRow(resp.row_delta);
    // Remove the most recent mismatch log entry for this row (best-effort).
    if (this.mismatchLog.length > 0) this.mismatchLog.pop();
    this.dispatchChange(new Set([row]));
    return { outcome: 'applied' };
  }

  /* ---------- helpers ---------- */

  dispose(): void {
    this.syncWindow.dispose();
  }

  /* eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types --
   * internal dispatch helper typed via the public payload union. */
  private gate(env: GridEventEnvelope<GridPayload>, _kind: string): ApplyResult | null {
    if (env.grid_epoch < this.epoch) {
      this.telemetry.incr('stale_epoch_drop');
      return { outcome: 'discarded', reason: 'stale_epoch' };
    }
    if (env.grid_epoch > this.epoch) {
      // Epoch advanced and we haven't seen a snapshot yet → request one.
      this.telemetry.incr('stale_epoch_drop');
      this.awaitingSnapshot = true;
      this.onSnapshotResyncFn?.({
        session_id: env.session_id,
        epoch: env.grid_epoch,
        reason: 'epoch_advanced_without_snapshot',
      });
      return { outcome: 'snapshot_requested' };
    }
    if (this.awaitingSnapshot) {
      this.telemetry.incr('stale_sequence_drop');
      return { outcome: 'discarded', reason: 'stale_sequence' };
    }
    if (env.sequence_no <= this.appliedSequence) {
      this.telemetry.incr('stale_sequence_drop');
      return { outcome: 'discarded', reason: 'stale_sequence' };
    }
    if (env.payload.kind === 'grid_delta' && env.resize_generation < this.resizeGeneration) {
      this.telemetry.incr('stale_resize_generation_drop');
      return { outcome: 'discarded', reason: 'stale_resize_generation' };
    }
    return null;
  }

  private writeRow(rd: RowDelta): void {
    const cells = expandSpans(rd.spans, this.colCount);
    this.rows[rd.row] = {
      cells,
      continuation: rd.continuation ?? false,
      revision: rd.revision_after,
    };
    this.rowRevisions[rd.row] = rd.revision_after >>> 0;
  }

  private recordMismatch(env: GridEventEnvelope<GridDeltaPayload>, row: number): void {
    this.telemetry.incr('revision_mismatch');
    const now = this.nowFn();
    this.mismatchLog.push(now);
    // Trim entries older than the window.
    const cutoff = now - this.stormWindowMs;
    while (this.mismatchLog.length > 0 && (this.mismatchLog[0] ?? 0) < cutoff) {
      this.mismatchLog.shift();
    }
    if (this.mismatchLog.length >= this.stormK) {
      this.telemetry.incr('snapshot_fallback_storm_triggered');
      this.telemetry.incr('snapshot_fallback');
      this.awaitingSnapshot = true;
      this.mismatchLog = [];
      this.onSnapshotResyncFn?.({
        session_id: env.session_id,
        epoch: this.epoch,
        reason: 'row_mismatch_storm',
      });
      return;
    }
    this.onRowResyncFn?.({
      session_id: env.session_id,
      grid_epoch: env.grid_epoch,
      resize_generation: env.resize_generation,
      row,
    });
  }

  private dispatchChange(dirty: Set<number>): void {
    this.syncWindow.accumulateOrEmit(dirty);
  }
}

function expandSpans(
  spans: ReadonlyArray<{
    cols: number;
    sgr: string;
    graphemes: unknown;
    hyperlink_id?: number;
    ext?: unknown;
  }>,
  totalCols: number,
): readonly Cell[] {
  const out: Cell[] = [];
  for (const span of spans) {
    const grapheme = graphemeForSpan(span.graphemes);
    for (let i = 0; i < span.cols; i += 1) {
      out.push({
        grapheme: i === 0 ? grapheme : '',
        cols: span.cols,
        sgr: span.sgr,
        hyperlink_id: span.hyperlink_id ?? 0,
        ext: (span.ext as Cell['ext']) ?? null,
      });
    }
  }
  // Pad / truncate to totalCols so consumers can index by col directly.
  while (out.length < totalCols) {
    out.push({
      grapheme: '',
      cols: 1,
      sgr: '0x0000000000000000',
      hyperlink_id: 0,
      ext: null,
    });
  }
  if (out.length > totalCols) out.length = totalCols;
  return out;
}

function graphemeForSpan(g: unknown): string {
  if (g === 'blank') return '';
  if (g && typeof g === 'object') {
    const obj = g as Record<string, unknown>;
    if ('utf8' in obj) {
      const u = obj.utf8;
      if (typeof u === 'string') return u;
      if (Array.isArray(u)) {
        // Decode bytes using TextDecoder (UTF-8).
        const bytes = Uint8Array.from(u as number[]);
        return new TextDecoder('utf-8').decode(bytes);
      }
    }
    if ('grapheme' in obj && typeof obj.grapheme === 'string') {
      return obj.grapheme;
    }
  }
  return '';
}

function blankRow(cols: number): Row {
  const cells: Cell[] = new Array<Cell>(cols);
  for (let i = 0; i < cols; i += 1) {
    cells[i] = {
      grapheme: '',
      cols: 1,
      sgr: '0x0000000000000000',
      hyperlink_id: 0,
      ext: null,
    };
  }
  return { cells, continuation: false, revision: 0 };
}

function noopTelemetry(): MirrorTelemetry {
  return { incr: (_name: MirrorCounterName, _by = 1): void => undefined };
}

/** A simple `MirrorTelemetry` sink backed by a Map — useful in tests. */
export class CountingTelemetry implements MirrorTelemetry {
  private readonly counts = new Map<MirrorCounterName, number>();
  incr(name: MirrorCounterName, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by);
  }
  get(name: MirrorCounterName): number {
    return this.counts.get(name) ?? 0;
  }
}
