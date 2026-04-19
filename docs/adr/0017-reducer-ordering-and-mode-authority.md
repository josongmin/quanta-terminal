# ADR 0017 — Reducer Ordering and Terminal Mode Authority

- **Status**: Proposed (skeleton — fleshed out during RFC 0001 Phase 1)
- **Date**: 2026-04-19
- **Related**: RFC 0001 §9 (reducer + mode authority), ADR 0011 (event replay / reducer semantics), ADR 0014 (architecture invariants)

## Context

The custom VT engine (RFC 0001) emits a stream of events (`GridSnapshot`, `GridDelta`, `CursorMoved`, `ModeChanged`, etc.) that the UI mirrors to render on screen.

Three classes of production bug all root in the same problem:

1. **Stale delta after reconnect**: host disconnects, engine re-boots, new epoch begins, old in-flight delta arrives and corrupts the new grid.
2. **Resize interleaving**: resize fires, rows reflow, but an older delta targeting the pre-resize geometry applies against the new one → cursor ends up 3 columns wrong, rest of session misaligned.
3. **Mode drift**: input encoder reads `TerminalModeState` while a `ModeChanged` is in flight from a different task → bracketed-paste toggle applies to the wrong keystroke.

All three have the same fix: **one ordered reducer stream, with epoch + generation fencing, and a snapshot-based mode read.** This ADR locks that down.

## Decision

### 1. Event envelope

Every engine-emitted event carries:

```rust
struct EventEnvelope<P> {
    session_id: SessionId,
    grid_epoch: u64,         // changes on reconnect / full reseed / buffer init
    sequence_no: u64,        // strictly ascending within an epoch
    buffer_kind: BufferKind, // Main | Alt
    resize_generation: u64,  // increments on every resize affecting wrap/reflow
    payload: P,
}
```

### 2. Application rules

- Events apply in `(grid_epoch, sequence_no)` lexicographic ascending order per session.
- Stale-epoch events are **discarded**, not "applied best-effort."
- Stale-`resize_generation` deltas are **discarded**.
- `CursorMoved` / `ModeChanged` older than the latest applied `sequence_no` are **rejected**.
- Alt-screen enter/exit `ModeChanged` is sequenced **before** the first cell-delta of the new buffer. UI chrome transitions begin only after the `ModeChanged` is applied.

### 3. Recovery

- `ResyncRow` is allowed **only** when `(grid_epoch, resize_generation)` match.
- If row-level recovery isn't possible, UI requests full `GridSnapshot`.
- Reconnect / resume fences ALL pre-reconnect events via a new `grid_epoch`. UI sees the new epoch and discards anything older.

### 4. Terminal mode authority

All negotiated input modes live in a single authoritative `TerminalModeState`:

- DECCKM (cursor-key application mode)
- Bracketed paste (DECSET 2004)
- Focus reporting (DECSET 1004)
- Mouse tracking (1000 / 1002 / 1003) + SGR encoding (1006)
- `modifyOtherKeys` level
- Kitty keyboard protocol level
- Alt-screen active
- Synchronized update (DECSET 2026)

Rules:

- **Input encoder reads a snapshot of `TerminalModeState`** at the start of each `key_event` / `mouse_event` / `paste` call. No live reads mid-encode.
- PTY-driven mode changes update `TerminalModeState` through the **same reducer stream** as visual state (i.e., they go through `ModeChanged` events with `sequence_no`).
- No browser event handler infers mode independently. No "I saw this pattern in past bytes, so I assume mouse mode is on."
- Mode reads used for key encoding are **sequence-consistent** with the latest applied reducer state.

### 5. Telemetry

- Counter: out-of-order events dropped.
- Counter: stale-epoch deltas discarded.
- Counter: row resync requests.
- Counter: full-snapshot fallbacks.
- Counter: mode-negotiation conflicts (e.g., two concurrent programs fighting over `modifyOtherKeys`).

Snapshot-fallback **storms** (> 3/min sustained) are a P1 signal — indicates persistent divergence requiring investigation.

## Consequences

- Every event now carries 24 extra bytes of envelope metadata. Acceptable.
- `ResyncRow` code path becomes non-trivial (must validate epoch + generation). CI test covers.
- Input encoder API must accept a mode snapshot, not a live handle. Refactor contained.
- Mode changes are serialized through the same reducer as visual state — can't be "fast-pathed" around it, which is intentional: ordering correctness wins over latency.

## Open (to resolve during Phase 1 implementation)

- Whether `grid_epoch` is per-session or per-`(session, buffer_kind)` — leaning per-session since alt-screen is a buffer swap within an epoch, not a new epoch. Finalize during Phase 1.
- Wire format: `(u64, u64, u64, u8)` per event is 25 bytes. If bandwidth becomes tight, consider varint encoding. Not optimizing yet.
- Snapshot-fallback storm threshold: 3/min proposed; may tune based on dogfood telemetry.
