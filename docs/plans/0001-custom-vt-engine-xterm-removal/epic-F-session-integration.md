# EPIC-F — Session Integration + Actor Wiring

- **Status**: Design-ahead (Gear 3). Freezes the actor ↔ engine invocation contract and the event-log persistence shape for new VT events.
- **Date**: 2026-04-19
- **Related**: RFC 0001 §7.9 (scrollback authority — event log is canonical), §9 (reducer ordering), §13.7 (dirty/delta), §13.9 (compat programs), ADR 0011 (replay determinism / durable commit ordering), ADR 0017 (reducer ordering + mode authority), ADR 0018 (IME — unaffected here), EPIC-B Design (Grid, TerminalEvent, EventEnvelope), EPIC-C Design (wire protocol + GridMirror), EPIC-E Design (input path, orthogonal).
- **Blocks**: `crates/quanta-session/src/adapters/actor.rs` implementation agent (Phase 3), resume-test authoring, EPIC-G compat matrix (which consumes an integrated session), EPIC-H degraded-mode handoff.

---

## 1. Summary

One-paragraph read: today the session actor at `crates/quanta-session/src/adapters/actor.rs` reads PTY bytes in `read_loop` (line 956), base64-encodes them into an `OutputChunk`, and dispatches to the single emitter task which assigns `monotonic_seq` and appends via `EventSink::append`. After EPIC-F the exact same read loop still owns the bytes, but before building `OutputChunk` it feeds each chunk through `quanta_vt::Grid::feed(bytes) -> Vec<TerminalEvent>` and emits one envelope per terminal event (stamped with `grid_epoch`, `sequence_no`, `resize_generation`, `buffer_kind`) through the emitter task. The `OutputChunk` path remains as a feature-flagged fallback (`session.use_vt_engine=false`) and for persistence of raw bytes until EPIC-I cuts xterm.js. Resize goes through `Grid::resize()` and bumps the engine's `resize_generation`. Resume rebuilds a fresh `Grid` from the event log, compares the reconstructed state against the UI's resume cursor, and either emits a `GridSnapshot` or an `EpochChanged` event depending on gap detection. Phase 3, ~1.5 weeks, ~8 working days including integration tests + fault-injection.

**Goal**: wire `quanta-vt` into `quanta-session`'s actor so every PTY byte produces durable, ordered, epoch-fenced terminal events that the UI can replay into an identical grid on reconnect — without breaking any existing session-actor test.

## 2. Background

### 2.1 Current actor hot path

The actor spawns three long-running tasks (actor.rs lines 280-393):

1. **reader task** (`read_loop`, line 956): drains the PTY in 8 KiB chunks (`PTY_READ_CHUNK_BYTES` = 8 × 1024, line 71), feeds each chunk into `VteBoundaryDetector` for block boundaries + `DiagnosticPipeline` for ADR 0007 diagnostics, base64-encodes the raw bytes, and emits one `Event::OutputChunk` per PTY chunk via `emit_nowait` (line 1073).
2. **input task** (`input_loop`, line 1439): drains a bounded mpsc of `InputCommand { Write, Resize, Cancel, Close }` and serializes them on the PTY.
3. **emitter task** (`emitter_loop`, line 783): the **single** assigner of `monotonic_seq`, the **single** caller of `EventSink::append`. Per ADR 0011 §Durable Commit Ordering, this guarantees strict ordering and a single durable seq space per session.

FIX 1 (actor.rs lines 297-301, 412-414) fail-closes the session on an append error: the `sink_failed` flag short-circuits input-facing methods to `SessionError::Closed` rather than hanging on a dead emitter ack channel.

### 2.2 Why change this

`OutputChunk` carries raw PTY bytes. The UI currently parses them via xterm.js. After EPIC-B, the **engine is authoritative**: raw bytes are no longer the UI's input, terminal events are. Per RFC §7.9, the event log is the scrollback source of truth; the engine's grid is a transient view on top of those events. This means:

- The actor must pass bytes through the engine **before** anything downstream sees them, so the event order matches the engine's semantic order (cell-deltas, cursor moves, mode changes).
- Resume must be deterministic: the event log replays into a fresh `Grid` and reproduces byte-identical state.
- Epoch fencing (ADR 0017) must stamp every event so a reconnecting UI can discard stale deltas.

### 2.3 Invariants preserved

- The emitter remains the sole seq assigner (ADR 0011).
- FIX 1 fail-closed behavior unchanged; a sink-append error on a VT event short-circuits identically.
- `emit` vs `emit_nowait` split preserved: `GridDelta`-style high-volume events go through `emit_nowait`; terminal milestones (`Resize`, `EpochChanged`, `SessionEnded`) go through ack-backed `emit`.
- Backpressure model unchanged: bounded mpsc between reader and emitter.

---

## 3. Scope

### 3.1 Files modified

- **`crates/quanta-session/Cargo.toml`** — add `quanta-vt = { path = "../quanta-vt" }` dependency.
- **`crates/quanta-session/src/adapters/actor.rs`** — integrate engine feed (see §4.1 for the exact insertion point); replace raw `OutputChunk` emission path behind a feature flag; add `resize_generation` stamping.
- **`crates/quanta-session/src/ports/mod.rs`** — re-export `TerminalEvent`, `EventEnvelope`, `GridEpoch`, `ResizeGeneration`, `BufferKind` from `quanta_vt` so downstream consumers have a single import point.
- **`crates/quanta-session/src/domain/mod.rs`** — extend `SessionConfig` with `use_vt_engine: bool` (defaults `true`) and `SessionSnapshot` with `grid_epoch: u64` + `resize_generation: u64`.
- **`crates/quanta-session/src/lib.rs`** — re-export the new port types.
- **`crates/quanta-core/src/adapters/fanout.rs`** — no type changes if `Envelope<Event>` already carries the union; otherwise widen the broadcast payload. Verify subscriber lag counters still bump under VT-event-heavy load.
- **`crates/quanta-events/src/adapters/zstd_segment.rs`** — round-trip serialize/deserialize new event variants; schema-evolution test with `#[serde(default)]` golden fixtures.
- **`crates/quanta-proto/src/events.rs`** — add `Event::Grid(GridEvent)` outer variant wrapping `GridSnapshot | GridDelta | CursorMoved | ModeChanged | Resize | EpochChanged | BellRequested | TitleChanged | CwdChanged | HyperlinkOpened | HyperlinkClosed | ClipboardRequest | OscPassthrough | ClearScrollback | SynchronizedUpdate` (shapes per EPIC-C). The inner shape is owned by EPIC-C; EPIC-F only wires the outer variant.
- **`crates/quanta-proto/src/envelope.rs`** — extend `Envelope<P>` with `grid_epoch`, `resize_generation`, `buffer_kind` OR document they ride on the payload when the payload is `GridEvent`. (Decision below in §4.5.)

### 3.2 Files new

- **`crates/quanta-session/tests/vt_integration.rs`** — end-to-end: spawn an actor, feed a scripted PTY byte stream via a `PtyPort` test double, read back the fanout broadcast, assert the terminal-event trace exactly matches a committed golden.
- **`crates/quanta-session/tests/resize_generation.rs`** — spawn, emit some output, call `resize()`, emit more output; assert `resize_generation` bumped on the second batch and not on the first.
- **`crates/quanta-session/tests/sink_failure_vt.rs`** — fault-injection: sink-append error mid-VT-event-stream → `sink_failed` flag flips, terminal `SessionEnded(SinkFailure)` emitted, subsequent `submit_input` returns `SessionError::Closed`.
- **`tests/integration/tests/resume_vt.rs`** — disconnect + reconnect scenario: replay event log into a fresh `Grid`, emit `GridSnapshot` scoped to the reconnect cursor, assert byte-identical grid state pre- and post-reconnect.
- **`tests/integration/tests/epoch_change.rs`** — simulate log gap → engine declines replay → emits `EpochChanged` → UI consumer discards pre-gap state.
- **`crates/quanta-events/tests/vt_event_roundtrip.rs`** — serialize each new event variant, deserialize, assert structural equality; schema-evolution cases with `#[serde(default)]` missing-field tolerance.

### 3.3 Out of scope

- The engine itself (EPIC-B owns `quanta-vt` crate).
- Wire-format JSON shape per payload (EPIC-C).
- UI consumption / `GridMirror` (EPIC-C).
- Input encoding path (EPIC-E).
- Compat-matrix recordings (EPIC-G).
- Block overlay alt-screen UX (EPIC-H — consumes `ModeChanged(AltScreen,_)` but does not drive it).

---

## 4. Design

### 4.1 Actor hot-path change

**Before (actor.rs lines 1059-1099):**

```rust
// inside read_loop, after `let bytes = &buf[..n];`
let (active_block, outcome) = { /* state.lock + output_store.append */ };
if let Some(active) = active_block {
    if let Some(outcome) = outcome {
        let b64 = encode_b64_reuse(bytes, &mut b64_scratch);
        emit_nowait(&emit_tx, Producer::Output, Event::OutputChunk(OutputChunk { /* ... */ })).await?;
    }
}
```

**After:**

```rust
// same outer state.lock; output_store.append still runs so the offset ledger
// stays authoritative for the block-output surface used by CLI export.
let (active_block, outcome) = { /* unchanged */ };

if config.use_vt_engine {
    // Feed the engine. Grid::feed returns owned events; there is no I/O inside.
    let events = grid.feed(bytes);
    for ev in events {
        let envelope_payload = Event::Grid(to_grid_event(ev));
        // Grid events are high-volume; use emit_nowait to avoid the ack
        // round-trip. Ordering is preserved by the emitter mpsc FIFO.
        emit_nowait(&emit_tx, Producer::Terminal, envelope_payload).await?;
    }
    // Preserve OutputChunk emission behind the same feature flag for
    // cross-cutting consumers that still need raw bytes (diagnostic
    // pipeline output, CLI export). Will be removed in EPIC-I after
    // xterm.js is cut.
    if let (Some(active), Some(outcome)) = (active_block, outcome) {
        let b64 = encode_b64_reuse(bytes, &mut b64_scratch);
        emit_nowait(&emit_tx, Producer::Output, Event::OutputChunk(OutputChunk { /* same */ })).await?;
    }
} else {
    // Pre-EPIC-F fallback path. Identical to today's code.
    if let (Some(active), Some(outcome)) = (active_block, outcome) {
        let b64 = encode_b64_reuse(bytes, &mut b64_scratch);
        emit_nowait(&emit_tx, Producer::Output, Event::OutputChunk(OutputChunk { /* same */ })).await?;
    }
}
```

The `Grid` instance lives on the reader task's stack (or a scoped `Arc<Mutex<Grid>>` if alt-screen toggling needs to race against resize — it does not today). Because the reader is single-threaded and owns `Grid` exclusively, no mutex is required around it. Resize is handled via a side-channel (see §4.3).

**`to_grid_event`** is a thin converter that moves `quanta_vt::TerminalEvent` into `quanta_proto::events::GridEvent`. The inner shape is owned by EPIC-C; EPIC-F only wires the call.

### 4.2 Emitter stamping

The emitter (actor.rs lines 783-950) today assigns `monotonic_seq` and stamps `Envelope::new(session_id, seq, producer, SchemaVersion::ONE, payload)`. For VT events we add four more stampings:

- `grid_epoch`: per-session counter held by the emitter (not the engine). Starts at 1 on `spawn`, bumps on **actor re-init** (unused in v1 — actors don't re-init), and on **detected log-gap during resume** (see §4.4).
- `sequence_no`: reuse the existing `monotonic_seq` — same counter, same ordering guarantee. ADR 0011's strict-monotonic contract is preserved.
- `resize_generation`: held by the emitter, mirrored into the engine on every resize. Starts at 0; bumped by `Resize` events (see §4.3).
- `buffer_kind`: Main | Alt; the engine stamps it on each event based on which buffer was active when the event was produced. The emitter copies it onto the envelope.

**Decision (ref: §3.1 last bullet)**: the four fields live on the **payload** for `Event::Grid(GridEvent { envelope_meta, inner })`, NOT on `Envelope<P>`. Rationale: non-VT events (`InputSubmitted`, `SessionCreated`, etc.) never carry them, so widening `Envelope<P>` would burden every unrelated producer with dead fields. The envelope keeps its 24-byte meta (ADR 0017 §1 explicitly allows this design — "every event carries 24 extra bytes of envelope metadata" is the ideal; the pragmatic form is "every Grid event carries them").

### 4.3 Resize

Today's `SessionHandle::resize()` (actor.rs line 508) forwards to the input task, which calls `PtyHandle::resize()`. For EPIC-F:

1. `resize()` enqueues an `InputCommand::Resize(size)` as before.
2. The input task calls `pty.resize(size)` (unchanged).
3. **New**: input task also signals the reader task (via a dedicated `tokio::sync::watch::Sender<PtySize>`) that a resize happened. The reader, on its next iteration, calls `grid.resize(rows, cols)` on its engine instance. The engine bumps its internal `resize_generation` and emits a `Resize` event.
4. The `Resize` event flows through the existing reader → emitter path. The emitter increments its `resize_generation` counter from the event payload (or mirrors the engine's value; decision: mirror). Subsequent grid events carry the new generation.

Why the watch channel and not a mutex on `Grid`: the reader must remain single-threaded over the engine to keep `Grid::feed` lock-free on the hot path. A watch channel signals without contention.

SIGWINCH to the child process: unchanged — `PtyHandle::resize()` forwards SIGWINCH per OS conventions. Retires RFC §22 #10.

### 4.4 Resume semantics

Host reconnects carrying a `ResumeCursor { session_id, grid_epoch, last_applied_seq, resize_generation }`. The resume handler (new function `resume_session` in `actor.rs` or a sibling module):

1. **Fetch the event log tail**: read all envelopes for `session_id` with `seq > last_applied_seq` from `ZstdSegmentedEventLog`.
2. **Gap check**: if the tail's first seq is not `last_applied_seq + 1`, we have a log gap. **Do not replay**. Emit `EpochChanged { new_epoch, reason: LogGap }`; UI discards pre-reconnect state and requests a fresh snapshot.
3. **Epoch check**: if the current session's `grid_epoch` ≠ the resume cursor's `grid_epoch`, emit `EpochChanged { new_epoch, reason: EpochMismatch }`.
4. **Resize-generation check**: if the resume cursor's `resize_generation` < current session's, the UI is stale; emit a `GridSnapshot` scoped to the current geometry.
5. **Replay path**: instantiate a fresh `Grid`, feed every envelope's inner payload (the `OutputChunk`-preserved raw bytes from §4.1) through `Grid::feed`, discard the replay events, emit a `GridSnapshot` of the final state. Post-replay, live events resume from the current tail.

**Invariant**: the event log is authoritative (RFC §7.9). The engine's grid is a view. A replay MUST produce byte-identical output to the live session if fed the same byte stream. This is the content of `crates/quanta-events/tests/vt_event_roundtrip.rs` + `tests/integration/tests/resume_vt.rs`.

Resume does **not** re-use the live session's `Grid` instance — it always builds a fresh one. This avoids torn-state bugs where a live grid has diverged from the log due to a previous gap.

### 4.5 Event-log persistence

All VT events are persisted through the existing `EventSink::append` path. Schema rules:

- **Additive fields only**. Every new field on `GridEvent` payloads carries `#[serde(default)]` on the Rust side.
- **Golden fixtures committed**. One per event variant under `crates/quanta-proto/tests/fixtures/schemas/grid_*.golden.json`. EPIC-C owns the file layout; EPIC-F ensures the emitter produces them on the right shape.
- **Round-trip determinism**. `crates/quanta-events/tests/vt_event_roundtrip.rs` proves: serialize-then-deserialize == identity for every variant; deserialize-old-shape-with-new-struct drops unknown fields gracefully.
- **Replay determinism**. Given an event-log file, reconstructing the grid from it produces the same event sequence when re-emitted. Covered in `tests/integration/tests/resume_vt.rs`.

Event-log segment size growth: cell deltas are denser than `OutputChunk`s. Compaction is an ADR 0005 concern (already-accepted) — EPIC-F does not change the compaction policy. Risk tracked in §10.

---

## 5. Definition of Done (DoD)

The implementation agent may mark EPIC-F complete only when every item below is true. Numbering is stable; `DoD-F-##` can be referenced from downstream plans and PR checklists.

### 5.1 Engine integration

- [ ] **DoD-F-01** — Every PTY byte chunk read by `read_loop` passes through `Grid::feed` before any VT event is emitted. No bypass path exists when `config.use_vt_engine == true`. Asserted by `vt_integration.rs`: a byte trace is captured from the engine's feed log, and byte parity with the PTY adapter's write log is checked.
- [ ] **DoD-F-02** — `Grid::feed` is called from exactly one thread (the reader task). No `Mutex<Grid>` lock appears in the hot path. Verified by code review + a compile-time `!Sync` check on the stored `Grid` handle.
- [ ] **DoD-F-03** — Pre-engine code paths (`VteBoundaryDetector`, `DiagnosticPipeline`, `OutputStore::append`) still fire on every chunk. No existing test breaks because the engine swallows their input.

### 5.2 Event stamping

- [ ] **DoD-F-04** — Every emitted VT event carries the tuple `(grid_epoch, sequence_no, resize_generation, buffer_kind)` in its `GridEvent::envelope_meta`. Asserted in `vt_integration.rs` across ≥ 10 event types.
- [ ] **DoD-F-05** — `sequence_no` is strictly ascending within a single `grid_epoch`. Asserted by replaying the event log and checking `seq[i] < seq[i+1]` for all adjacent same-epoch entries.
- [ ] **DoD-F-06** — `resize_generation` increments exactly once per `resize()` call, and new-generation events never appear before the corresponding `Resize` event. Asserted in `resize_generation.rs`.
- [ ] **DoD-F-07** — `buffer_kind` flips from `Main` to `Alt` strictly after a `ModeChanged(AltScreen, true)` event; never before. Asserted in `vt_integration.rs` against a `vim` golden stream.
- [ ] **DoD-F-08** — `ModeChanged(AltScreen, true)` appears in the event stream **before** the first `GridDelta` whose `buffer_kind == Alt`. Retires RFC §22 #8.

### 5.3 Event-log persistence

- [ ] **DoD-F-09** — Every new event variant has a committed golden fixture at `crates/quanta-proto/tests/fixtures/schemas/grid_*.golden.json`. Count: ≥ 12 (one per EPIC-B `TerminalEvent` variant).
- [ ] **DoD-F-10** — `vt_event_roundtrip.rs` proves serialize ∘ deserialize == identity for every variant.
- [ ] **DoD-F-11** — Schema-evolution test: a future-shape event (extra fields) deserializes into the current struct with the extras dropped silently (`#[serde(default)]` + `#[serde(deny_unknown_fields)]` **NOT** set on grid-event structs).
- [ ] **DoD-F-12** — Replay-determinism test: reading an event log back and re-feeding its bytes into a fresh `Grid` produces the same `TerminalEvent` sequence (byte-parity on the emitted payload).

### 5.4 Resume semantics

- [ ] **DoD-F-13** — `resume_vt.rs` proves byte-identical grid state pre- and post-reconnect for a 1 MB output stream. "Byte-identical" = the `GridSnapshot` emitted post-replay deserializes to a grid structurally equal to the live grid at the time of disconnect.
- [ ] **DoD-F-14** — Log-gap detection emits `EpochChanged { reason: LogGap }` and does NOT replay. Asserted in `epoch_change.rs`.
- [ ] **DoD-F-15** — Epoch-mismatch detection emits `EpochChanged { reason: EpochMismatch }` and discards the UI's cursor.
- [ ] **DoD-F-16** — Post-`EpochChanged`, the next envelope UI sees is a fresh `GridSnapshot`, not a `GridDelta`. Ordering asserted by `epoch_change.rs`.

### 5.5 Resize handling

- [ ] **DoD-F-17** — `SessionHandle::resize()` forwards to the PTY AND triggers `Grid::resize()` on the reader task. Both paths observed in `resize_generation.rs`.
- [ ] **DoD-F-18** — SIGWINCH is delivered to the PTY child process exactly once per `resize()` call (unchanged from today, but verified by a `PtyPort` test double that counts `resize` invocations). Retires RFC §22 #10.
- [ ] **DoD-F-19** — Reflow on resize: continuation-tagged rows reflow according to EPIC-B semantics; `\n`-terminated rows do not. Tested indirectly via the grid-snapshot comparison in `resize_generation.rs`.

### 5.6 Backward compatibility

- [ ] **DoD-F-20** — `cargo test --workspace` green. All existing session-actor tests in `crates/quanta-session/tests/**` continue to pass without modification (except `resize_generation.rs` which is new).
- [ ] **DoD-F-21** — `cargo clippy --workspace -- -D warnings` clean.
- [ ] **DoD-F-22** — The old `OutputChunk` emission path is preserved behind `config.use_vt_engine == false`. `SessionConfig::default()` sets it to `true`; a rollback flips the bit.
- [ ] **DoD-F-23** — Existing `replay_session` semantics (ADR 0011) unchanged: the same event log replays into the same reducer state regardless of whether VT events are present, because `Event::Grid(_)` variants are no-ops to the block reducer (grid events do not affect block boundaries — those are still OSC 133 + VteBoundaryDetector-driven).

### 5.7 Session close / fault handling

- [ ] **DoD-F-24** — Session close emits a final `SessionEnded` event; the in-memory `Grid` is dropped; the event log is preserved. No dangling files, no leaked task handles (existing join protocol unchanged).
- [ ] **DoD-F-25** — Sink-append error mid-VT-event emission → `sink_failed` flag flips, terminal `SessionEnded(SinkFailure)` appended, further input returns `SessionError::Closed`. Asserted in `sink_failure_vt.rs`. Retires RFC §22 #16 (part: fail-closed instead of "best-effort continuation").
- [ ] **DoD-F-26** — Fanout subscriber lag on VT-event-heavy load: the `fanout.broadcast.subscriber_lag_drops` counter bumps when a subscriber falls behind; the durable append path is unaffected (existing FIX 4 behavior; verify still holds under the new event volume).

### 5.8 Feature flag & rollback

- [ ] **DoD-F-27** — Feature flag `SessionConfig::use_vt_engine: bool` plumbed end-to-end. Default `true`. An integration test spawns with `use_vt_engine=false` and asserts old-path behavior (pure `OutputChunk` stream, zero `Event::Grid(_)` envelopes).
- [ ] **DoD-F-28** — Rollback documented in §11: setting the flag to `false` returns to the pre-EPIC-F emitter path. Flag is removed in EPIC-I.

### 5.9 Telemetry hooks

- [ ] **DoD-F-29** — `session.vt.events_emitted{kind}` counter wired, labeled by event kind (`grid_delta`, `cursor_moved`, `mode_changed`, `resize`, `title_changed`, etc.).
- [ ] **DoD-F-30** — `session.vt.feed_latency_us` histogram wired around every `Grid::feed` call on the reader task. P99 > 1 ms is a telemetry alarm (cross-cutting EPIC-J ownership); EPIC-F wires the probe only.

---

## 6. Quality Gates

Each gate is a CI check and must be green for EPIC-F to exit.

| Gate | Enforced by | Failure behavior |
|---|---|---|
| G-F-01 Workspace tests green | `.github/workflows/ci.yml` → `cargo test --workspace` | PR blocked. |
| G-F-02 Clippy clean | `cargo clippy --workspace -- -D warnings` | PR blocked. |
| G-F-03 VT integration end-to-end | `crates/quanta-session/tests/vt_integration.rs` | Test red → PR blocked. |
| G-F-04 Resize generation monotonic | `crates/quanta-session/tests/resize_generation.rs` | Test red → PR blocked. |
| G-F-05 Sink-failure fail-closed | `crates/quanta-session/tests/sink_failure_vt.rs` | Test red → PR blocked. |
| G-F-06 Resume byte-identical | `tests/integration/tests/resume_vt.rs` | Test red → PR blocked. |
| G-F-07 Epoch-change on log gap | `tests/integration/tests/epoch_change.rs` | Test red → PR blocked. |
| G-F-08 Event round-trip | `crates/quanta-events/tests/vt_event_roundtrip.rs` | Test red → PR blocked. |
| G-F-09 Schema-evolution tolerant | `vt_event_roundtrip.rs` — missing-field subtest | Test red → PR blocked. |
| G-F-10 Existing session tests unchanged | `cargo test -p quanta-session` | Any pre-EPIC-F test fails → PR blocked. |
| G-F-11 Feature-flag rollback works | `vt_integration.rs` — `use_vt_engine=false` subtest | Test red → PR blocked. |
| G-F-12 `Event::Grid` additive-only | `tools/check-proto-grid-additive/check.sh` (grep for `#[serde(deny_unknown_fields)]` on GridEvent structs) | Script exits 1 → PR blocked. |
| G-F-13 No `Mutex<Grid>` on hot path | `tools/check-grid-no-mutex/check.sh` — greps `crates/quanta-session/src/adapters/actor.rs` for `Mutex<Grid>` | Script exits 1 → PR blocked. |

Gates G-F-12 / G-F-13 are tiny grep checks owned by the EPIC-K cross-cutting agent but listed here so EPIC-F exit confirms them.

---

## 7. E2E scenarios

Each scenario runs under `tests/integration/`. Pass = expected event trace matches the committed golden AND any UI-observable side effect (grid cell content, mode flag, banner) matches.

- **E2E-F1 — Echo hello round-trip**: spawn a session, run `echo hello`, observe the fanout. Assert: at minimum one `GridDelta` event with `cells = [{ row: 0, col: 0, grapheme: "h" }, ..., { col: 4, grapheme: "o" }]` (or row 1 depending on prompt geometry); one `CursorMoved` after the write; `Grid::snapshot` contains "hello" contiguously. Byte-parity with golden `echo_hello.events.json`.
- **E2E-F2 — Vim alt-screen ordering**: spawn a session, `vim /tmp/empty.txt`. Observe the fanout. Assert: `ModeChanged { mode: AltScreen, value: true }` strictly precedes the first `GridDelta { buffer_kind: Alt }`. Retires RFC §22 #8.
- **E2E-F3 — Resize generation bump**: spawn 80×24, emit ~10 lines of output, call `resize(120, 40)`, emit another ~10 lines. Assert: events in the first batch carry `resize_generation = 0`; the `Resize` event carries `resize_generation = 1`; all subsequent events carry `resize_generation = 1`. SIGWINCH observed exactly once by the PTY double. Retires RFC §22 #10.
- **E2E-F4 — Resume replay identity**: spawn, emit 1 MB of output (`seq 1 100000`), disconnect the UI client mid-stream (simulated: drop the broadcast receiver at seq = 50000). Reconnect with `ResumeCursor { last_applied_seq: 50000, grid_epoch: current, resize_generation: 0 }`. Assert: engine replays seq 50001..tail into a fresh grid, emits a `GridSnapshot` scoped to the reconnect state, and the post-replay grid is structurally equal to the live grid at the reconnect moment. Retires RFC §22 #16 (ordering guarantee under replay).
- **E2E-F5 — Engine crash → EpochChanged**: spawn a session; inject a log-gap by advancing the emitter's seq counter without appending the intervening event (test hook). Client reconnects with a stale `ResumeCursor`. Assert: engine detects the gap, emits `EpochChanged { reason: LogGap, new_epoch: 2 }`, UI consumer discards pre-reconnect state, next event is a fresh `GridSnapshot`. Retires RFC §22 #17 (engine crash → EpochChanged → degraded-mode handoff, UX owned by EPIC-H).
- **E2E-F6 — Sink-append fail-closed**: spawn a session with an `EventSink` test double that returns `EventLogError::Io` after the 100th append. Emit 200 events. Assert: on the 100th, `sink_failed` flips, terminal `Event::SessionEnded(SinkFailure)` is appended (the 101st and last successful event — or fails and is logged at error level per FIX 1), subsequent `submit_input` returns `SessionError::Closed`, `close()` is idempotent and safe.
- **E2E-F7 — Concurrent-session epoch isolation**: spawn two sessions via the same `Engine`. Emit output on both concurrently. Assert: each session has an independent `grid_epoch` (both start at 1; they do not collide), each has an independent `sequence_no` counter (both advance 1, 2, 3, ... inside their own session_id space), and the fanout stream correctly attributes events to the right `session_id`.
- **E2E-F8 — Schema-evolution forward/backward**: serialize a present-shape `GridDelta` (fields: `cells`, `row_range`, `revision`). Produce a synthetic future-shape blob by appending an unknown field `foo_bar: 42`. Deserialize into present-shape struct. Assert: deserialization succeeds, the unknown field is dropped, the rest of the struct is byte-identical to the original.

---

## 8. Test deliverables

| File | Scope | Target case count |
|---|---|---|
| `crates/quanta-session/tests/vt_integration.rs` | Hot-path: PTY → engine → fanout | **≥ 10** scripted byte streams (echo, vim, less, htop, resize-during-output, alt-screen-enter, alt-screen-exit, title-set, cwd-change, bell) |
| `crates/quanta-session/tests/resize_generation.rs` | Resize counter monotonicity | **≥ 5** (single resize, back-to-back resizes, resize-during-alt-screen, resize-with-no-output-between, resize + SIGWINCH observed) |
| `crates/quanta-session/tests/sink_failure_vt.rs` | Fault injection on append | **≥ 4** (fail at N=1, fail mid-grid-delta, fail on terminal SessionEnded, fail under concurrent submit_input) |
| `tests/integration/tests/resume_vt.rs` | Replay determinism | **≥ 6** (small output, 1 MB output, alt-screen transition mid-stream, resize mid-stream, consecutive disconnect-reconnect cycles, reconnect with stale resize_generation) |
| `tests/integration/tests/epoch_change.rs` | Epoch bump on gap | **≥ 3** (log gap, epoch mismatch, concurrent disconnect + log rotation) |
| `crates/quanta-events/tests/vt_event_roundtrip.rs` | Serde round-trip | **≥ 12** (one per event variant) + **≥ 3** schema-evolution cases |
| `crates/quanta-proto/tests/grid_schema_snapshots.rs` | Golden JSON parity (inherited from EPIC-C; EPIC-F extends with persistence-layer snapshots) | **≥ 12** |

Line coverage target on `crates/quanta-session/src/adapters/actor.rs` ≥ 85% (existing floor; no regression).

---

## 9. Failure modes retired

Reference RFC §22 (20-point list):

- **RFC §22 #8** (DECSET 1049 enter races first alt-frame) — EPIC-B emits `ModeChanged` before the first alt-buffer delta; EPIC-F preserves that ordering across the actor → fanout path. Retired by **E2E-F2**.
- **RFC §22 #10** (SIGWINCH not sent to child → program state diverges) — `resize()` path unchanged; `PtyHandle::resize()` still forwards SIGWINCH; now also triggers `Grid::resize()`. Retired by **E2E-F3** + SIGWINCH assertion in `resize_generation.rs`.
- **RFC §22 #16** (out-of-order deltas → resync storm) — strict `(grid_epoch, sequence_no)` ordering guaranteed by single-emitter protocol (ADR 0011) + emitter-stamped payloads. Retired by **E2E-F4** (replay determinism) + **E2E-F6** (fail-closed on sink error, no "best-effort continuation" that would create a gap).
- **RFC §22 #17** (engine crash → black screen) — on engine-side panic or sink failure, the session fails closed with `SessionEnded(SinkFailure)` and the UI transitions to degraded mode. EPIC-F does the fail-closed half; EPIC-H owns the UX banner + read-only frame. Retired by **E2E-F5** + **E2E-F6** with UX handoff to EPIC-H.

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Event-log segment size grows significantly with cell deltas (~10-30× denser than OutputChunk) | High | Medium | ADR 0005 compaction policy already covers periodic segment rotation + zstd dictionary tuning. EPIC-F ships size-baseline measurement in telemetry; EPIC-J dashboards track it; compaction-policy adjustments are a follow-up if baseline exceeds the budget. |
| Concurrent resize + heavy output → sequence-ordering bug (resize signal races the next `feed`) | Medium | High | All reader-task actions are serialized through the single reader loop. The resize signal is a `watch` channel, consumed at the top of each loop iteration. Test `resize_generation.rs` covers resize-between-feeds AND resize-while-feeding (driven by a PTY double that emits bytes continuously). |
| `Grid::feed` latency spikes (e.g. a huge SGR reset sequence) stall the reader, starving the input task | Medium | Medium | Existing reader/input priority mechanism (actor.rs lines 998-1005 `write_pending` + `write_ready`) keeps writes interleaved. Telemetry probe `session.vt.feed_latency_us` P99 alarms if sustained stalls appear; EPIC-B's engine design budgets `feed` at sub-millisecond per 8 KiB chunk. |
| Backward compat: older client connections without `grid_epoch` handling reject the new envelope shape | Low | High | ADR 0017 Hello compat check: clients declare their protocol version at handshake; an older client falls back to the `OutputChunk`-only stream via the `use_vt_engine=false` code path at the session level. The compat gate blocks a VT-event stream from reaching a client that cannot parse it. |
| `Event::Grid` variant breaks existing `replay_session` semantics if the block reducer accidentally consumes it | Low | Medium | `quanta_block::BlockReducer` treats `Event::Grid(_)` as a no-op (does not affect block boundaries). Asserted in `crates/quanta-block/tests/reducer_properties.rs` via a new property test: adding `Event::Grid(_)` envelopes to any event sequence does not change the reducer's final block state. |
| The 8 KiB `PTY_READ_CHUNK_BYTES` split mid-CSI sequence → engine sees partial ESC sequences across chunk boundaries | Certain (for large sequences) | Low | `Grid::feed` from EPIC-B owns a stateful VTE parser (`vte::Parser`) that carries partial CSI state across calls. EPIC-F's contract is that `feed` is called with every byte exactly once in order; the engine handles cross-chunk fragmentation internally. Covered by EPIC-B's parser tests. |

---

## 11. Rollback

**Soft rollback — per-session**: instantiate a `SessionConfig` with `use_vt_engine: false`. The actor runs the pre-EPIC-F emitter path; no `Event::Grid(_)` envelopes are produced; the UI falls back to xterm.js parsing of `OutputChunk` bytes (still legal pre-EPIC-I). No data migration, no schema change.

**Global rollback**: flip the default on `SessionConfig::use_vt_engine` from `true` to `false` in one constant edit. Redeploy. The engine code paths are dormant but present; re-enabling flips the bit back.

**Hard rollback**: revert the EPIC-F merge commit. All new test files are deleted; `actor.rs` returns to its pre-EPIC-F shape. Safe because EPIC-F is additive to the existing emitter path — no pre-existing behavior was altered, only gated behind the feature flag.

**Flag removal**: the `use_vt_engine` field is removed in **EPIC-I** alongside xterm.js deletion. EPIC-F's existence as a feature-flagged layer is by design — once §19 gate is ALL-TRUE, the flag is dead code and goes away.

---

## 12. Cross-references

| Reference | Where it matters in EPIC-F |
|---|---|
| **RFC 0001 §7.9** (scrollback authority) | §4.4 resume semantics: event log is canonical. |
| **RFC 0001 §9** (reducer ordering) | §4.2 emitter stamping: `(grid_epoch, sequence_no)` strict order. |
| **RFC 0001 §13.7** (dirty/delta) | §4.1 actor hot path: `GridDelta` is the dominant event kind. |
| **RFC 0001 §13.9** (compat programs) | EPIC-G consumes the integrated session to run its compat matrix against live sessions. |
| **RFC 0001 §22 #8, #10, #16, #17** | §9 failure-modes retired table. |
| **ADR 0011** (replay determinism + durable commit ordering) | §4.2 single emitter / single seq assigner preserved; §4.5 round-trip determinism; DoD-F-23. |
| **ADR 0017** (reducer ordering + mode authority) | §4.2 stamping shape; §4.4 epoch-bump on gap; §10 backward-compat Hello check. |
| **EPIC-B** (consumed) | `Grid::feed`, `Grid::resize`, `TerminalEvent` enum. |
| **EPIC-C** (emitted → consumed) | Wire shape of `GridEvent` payloads; `GridMirror.apply()` consumes them on the UI side. |
| **EPIC-E** (parallel, disjoint) | Input encoding path; reads `TerminalModeState` via `GridMirror.snapshotMode()`; unaffected by EPIC-F's emitter changes. |
| **EPIC-G** (downstream) | Compat matrix runs against an integrated session; assumes EPIC-F's hot path is live. |
| **EPIC-H** (downstream) | Degraded-mode UX consumes `EpochChanged` + `SessionEnded(SinkFailure)`. EPIC-F produces these events; EPIC-H renders the banner. |
| **EPIC-I** (far downstream) | Removes the `use_vt_engine=false` fallback path once §19 gate is ALL-TRUE. |

---

## 13. Work breakdown (days)

### Week 1

- **Day 1**: Wire `quanta-vt` as a dependency of `quanta-session`. Add `use_vt_engine` to `SessionConfig`. Stub `Event::Grid(GridEvent)` variant in `quanta-proto` (inner shape coordinated with EPIC-C agent — use their frozen types once available, temporary placeholder otherwise).
- **Day 2**: Extend `read_loop` with the engine-feed path (§4.1). Thread `Grid` onto the reader task stack. Write `vt_integration.rs` with the echo-hello and vim-alt-screen scenarios; confirm byte parity with committed goldens.
- **Day 3**: Emitter stamping — `grid_epoch`, `resize_generation`, `buffer_kind`. `assign_seq` (actor.rs line 798) reused for `sequence_no`. Extend `Envelope::new` call site to produce `Event::Grid(GridEvent { envelope_meta, inner })`. Backward-compat test: existing session-actor tests green (DoD-F-20).
- **Day 4**: Resize plumbing — add `tokio::sync::watch::Sender<PtySize>` between input task and reader task. Reader calls `grid.resize()` on watch update. Write `resize_generation.rs` end-to-end. Confirm SIGWINCH still fires once per call (DoD-F-18).
- **Day 5**: Event-log persistence — extend `ZstdSegmentedEventLog` to serialize every new `GridEvent` variant. Write `vt_event_roundtrip.rs` + schema-evolution tests. Commit golden JSON fixtures under `crates/quanta-proto/tests/fixtures/schemas/grid_*.golden.json` (format owned by EPIC-C).

### Week 1.5

- **Day 6**: Resume semantics — write the `resume_session` function; gap detection; `EpochChanged` event emission. Extend `quanta-session` with the resume entry point.
- **Day 7**: Write `resume_vt.rs` and `epoch_change.rs` integration tests. Validate replay determinism on ≥ 1 MB output stream. Fail-closed fault injection: `sink_failure_vt.rs`.
- **Day 8**: Final review. Clippy pass. Telemetry probes wired (`session.vt.events_emitted`, `session.vt.feed_latency_us`). Gates G-F-01..G-F-13 green on CI. Update `docs/adr/0017-reducer-ordering-and-mode-authority.md` with any decisions captured during implementation (e.g. whether `grid_epoch` lives on `Envelope<P>` or `GridEvent::envelope_meta` — §4.2 decision).

**Buffer**: 1-2 days of contingency is built into EPIC-F's 1.5-week bucket. If resume semantics uncovers an unexpected log-gap edge case (e.g. segment rotation truncates a partial envelope), that contingency absorbs it without slipping EPIC-G's start.

---

## 14. Contract freeze checklist

At end of Week 1 (EPIC-F spec-freeze), the following are locked:

- [ ] Actor ↔ engine invocation contract: `Grid::feed(bytes) → Vec<TerminalEvent>` called **once per PTY chunk** on the reader task.
- [ ] `GridEvent::envelope_meta` shape: `{ grid_epoch: u64, sequence_no: u64, resize_generation: u64, buffer_kind: BufferKind }`.
- [ ] `SessionConfig::use_vt_engine: bool` flag surface.
- [ ] `SessionSnapshot` carries `grid_epoch` and `resize_generation`.
- [ ] `ResumeCursor { session_id, grid_epoch, last_applied_seq, resize_generation }` is the canonical resume handshake payload.
- [ ] `EpochChanged { new_epoch, reason: { LogGap | EpochMismatch | ManualReset } }` variant added to the terminal-event enum (EPIC-C wire-format owned; EPIC-F emits it).
- [ ] Event-log persistence: `#[serde(default)]` on every additive field of every new grid-event struct; `#[serde(deny_unknown_fields)]` **NOT** present (forbidden by G-F-12).
- [ ] `quanta-session` re-exports `TerminalEvent`, `GridEpoch`, `BufferKind`, `ResizeGeneration` through its `ports` module so downstream crates have a single import path.

Each contract is frozen via a PR that lands the type definitions; downstream epics (G, H) reference the commit SHA when consuming them.

---

## 15. Implementation-agent TODOs (deferred)

Items this design explicitly defers; the implementation agent resolves them before EPIC-F exits:

1. **Golden event-trace files for `vt_integration.rs`** — seed traces are scripted programs (echo, vim, less); the impl agent records them using the existing PTY harness and commits the byte + event pair.
2. **`EventLog` schema-version bump decision** — if the persistence layer's on-disk format already versions envelopes, adding `Event::Grid` variants is additive and requires no bump; verify at implementation time. If a bump is required, coordinate with the events-crate owner.
3. **Resume cursor transport** — EPIC-F assumes the host passes `ResumeCursor` as part of the Hello handshake. The exact wire shape is owned by EPIC-C (`quanta-protocol`). Coordinate before Day 6.
4. **Concurrent-session fanout sharding** — E2E-F7 covers correctness; if performance profiling shows broadcast-channel fanout is a bottleneck under many concurrent sessions, consider per-session broadcast senders. Decision deferred to EPIC-J.
5. **`Grid::feed` error path** — EPIC-B's `feed` signature is currently `-> Vec<TerminalEvent>` with no error. If feed ever becomes fallible (e.g. on grid-invariant violation), EPIC-F must surface the error through the actor's fail-closed pathway. Currently infallible per EPIC-B contract; revisit if EPIC-B's contract changes.
6. **Feature-flag telemetry** — a gauge `session.vt.use_vt_engine{value=true|false}` so dashboards show adoption. Wire only if EPIC-J asks for it during impl.
