# ADR 0011 — Event Replay, Reducer Determinism, and Resume

## Status

Accepted for Phase 1. Closes the gap between "the event log is append-only and replayable" (stated in product spec and technical architecture) and the operational reality of crash mid-flush, host reconnect, projection drift, and schema migration running against a partly-new log.

## Context

The product is event-sourced on the core side. Event sourcing is easy to state and easy to get wrong in production. The three recurring failure modes:

1. A reducer produces different projection state on replay than it did live. Silent divergence.
2. An event is re-delivered across a crash boundary and the reducer double-applies it. Silent duplication.
3. A host reconnects after a disconnect and either misses events or replays old ones. Silent gap or silent dup.

The current docs require monotonic seq and deterministic replay but do not pin down *how*. Different implementers will assume different guarantees. That is how "mostly works" ships to production and then fails a week later under load.

Opinion: commit to at-least-once delivery with idempotent reducers. Exactly-once across host reconnect and sidecar crash is achievable only with two-phase acknowledgment that costs more than it returns. Skip it, design for idempotency.

## Decision

### Delivery Guarantees

- **Sidecar → host event stream:** at-least-once. Events may be re-delivered after reconnect.
- **Host → sidecar RPC (control plane):** at-least-once. RPCs must be idempotent by the RPC's own `request_id`.
- **Core reducers:** must be pure functions of `(prior_state, event)`, deterministic for a fixed `schema_version`, and idempotent under re-delivery of the same `event_id`.

### Event Identity

Every event carries, in addition to the envelope fields already in the spec:

- `event_id: ulid` — globally unique, generated at the core before write. Used for dedupe.
- `monotonic_seq: u64` — per-session sequence. Gaps are never allowed; a gap is a corruption signal.
- `wall_clock_ts: rfc3339` — informational only, never authoritative for ordering.
- `producer_id: string` — `core`, or the adapter subsystem that originated the event. Needed to reason about where a duplicate came from.
- `schema_version: u32` — per event type, not global.
- `causation_id: ulid | null` — the `event_id` that caused this event, if any. Used for debugging and for cross-event invariants during replay.

### Reducer Contract

Every reducer consumes `(prior_state, event)` and returns `(next_state, derived_events[])`.

- **Purity:** no IO, no clock, no random. Anything time-dependent comes from `event.wall_clock_ts` treated as opaque metadata, not logic input, except where the invariant explicitly allows it (for example, duration derivation).
- **Idempotency key:** the reducer tracks `applied_event_ids` within each aggregate. Re-applying a known `event_id` is a no-op.
- **Determinism:** the same input sequence must produce the same output state, byte for byte. Tested in CI with a replay harness that reduces a fixture log twice and diffs projections.
- **No silent upgrade:** a reducer encountering an event at a `schema_version` it does not know refuses to reduce and emits a `reducer.incompatible_schema` event. The sidecar enters `degraded` state (see ADR 0004).

### Durable Commit Ordering

Write order inside the sidecar:

1. Append the event to the active log segment. `fsync` on segment boundary and on explicit commit points (every 100 ms or 1 MB, whichever first).
2. Only after the fsync of step 1 may a reducer update projections and persist to SQLite.
3. SQLite writes are batched per tick; a single SQLite transaction commits one tick's reducer outputs.
4. Only after the SQLite transaction commits does the sidecar acknowledge the causing RPC.

This order guarantees that a crash between step 1 and step 2 leaves the log correct and the projection temporarily behind, recoverable by replay. A crash between steps 2 and 3 leaves both correct; step 4 is the ack boundary.

### Resume Cursor

Each host connection negotiates a resume cursor on handshake:

- Host sends `last_applied_seq` per live session.
- Sidecar streams events from `last_applied_seq + 1` onwards.
- If the sidecar's log has been compacted past the cursor, sidecar sends a `resume.snapshot` payload followed by events from the new baseline.

The host discards any event with `monotonic_seq ≤ last_applied_seq` that arrives during reconnect, covering the at-least-once overlap.

### Snapshots

Projection snapshots are the replay fast path.

- Snapshot cadence: every 10,000 events per session, or every 30 minutes of activity, whichever first.
- Retention: the two most recent snapshots per session are kept; older ones GC with their events on compaction.
- Snapshot is a complete projection state for an aggregate, plus `last_applied_seq`, plus `schema_version`.
- On replay: load newest valid snapshot, apply events from `last_applied_seq + 1`.

A snapshot whose `schema_version` differs from the current reducer refuses to load; the replay falls back to the previous snapshot, or to cold replay if none loads.

### Projection Version Drift

Two kinds of drift can appear:

1. **Projection behind log.** After a crash between log flush and SQLite commit. Detected on startup by comparing `last_applied_seq` in SQLite with the last event in the log. Repair: replay the gap.
2. **Projection ahead of log.** Impossible by the write ordering above. If detected (truncated log), the later projection rows are the authoritative anomaly signal; sidecar enters `degraded`, quarantines the projection, rebuilds from log truncation point forward, and surfaces a recovery event.

### Dedupe Windows

- Event-log dedupe is not required because the sidecar is the only producer for a given session; `event_id` uniqueness is enforced at generation time.
- Host-side dedupe is required because at-least-once delivery on reconnect can produce duplicates. The host reducer maintains an LRU of recent `event_id` values per session, sized at 10,000.
- RPC dedupe uses `request_id` with a 60-second window on the sidecar side. Idempotent RPCs are safe to retry; non-idempotent ones have explicit design not to exist.

### Partial Flush and Torn Writes

- Every log record is length-prefixed and checksummed (xxhash). On read, a torn tail is truncated to the last valid record and a recovery event is appended.
- The SQLite WAL handles its own torn writes. Corruption of the DB file triggers the ADR 0005 quarantine-and-rebuild path, which is itself a replay.

### Out-of-Order Reducer Inputs

Within a session, `monotonic_seq` is strict. Out-of-order arrivals at the host are buffered until the gap closes or a timeout fires (default 30 seconds), after which the host requests resync. No reducer ever consumes a seq less than the one it last applied.

Across sessions, there is no ordering requirement; each session reduces independently.

### Cross-Event Invariants

Some invariants span events (for example, "a block must not emit `completed` before `started`"). These are enforced in the reducer. Violations raise a `reducer.invariant_violation` event and leave the prior state unchanged; the block stays in its last valid state. This is a data-integrity signal, surfaced in debug panel and captured in support bundles.

### Tests

- Replay determinism test: reduce a fixture log twice, diff the projection, fail on mismatch.
- Dedup test: inject duplicates at random positions, assert projection matches canonical run.
- Resume test: cut the stream at random points, reconnect, assert convergence.
- Schema-migration test: replay a log containing mixed `schema_version` through a migration chain and assert the final projection matches hand-authored expected state.

## Consequences

- Reducers are plain functions. Any temptation to sneak in IO is blocked at code review.
- The replay harness is a Phase 1 deliverable, not a future-work item.
- The host must track `last_applied_seq` per session durably enough to survive a reload; a small local index next to UI state handles this.
- Bugs that divulge as "the UI is out of sync" become reproducible by running the replay harness against the user's event log from their support bundle.
