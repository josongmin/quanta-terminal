# ADR 0004 — Sidecar Lifecycle Contract

## Status

Accepted for Phase 1. Fills the gap between "the host starts a Rust sidecar" and the reality of the bug that will haunt the product longest.

## Context

The technical architecture describes a Rust sidecar but does not pin down how the host discovers, boots, health-checks, recovers, or upgrades it. In every product that has shipped a long-running sidecar, the number-one long-tail bug class is "sometimes it doesn't attach." Leaving this implicit guarantees that bug class will appear and that different implementers will paper over it differently.

Opinion: the crash-recovery story is the single highest-leverage reliability investment. A small amount of discipline here pays back for the life of the product.

## Decision

### Protocol Versioning

- Sidecar and host each declare `protocol_version` as an integer plus a compatibility range.
- On connect, host sends `HELLO { host_protocol_version, host_version, client_id }`.
- Sidecar replies `READY { core_protocol_version, core_version, schema_version, sidecar_id, session_recovery_available: bool }`.
- If versions are incompatible, sidecar replies `INCOMPATIBLE { reason, supported_range }` and the host shows an upgrade prompt. No silent fallback.

### Startup State Machine

States the host tracks for the sidecar:

- `unstarted`
- `spawning`
- `handshaking`
- `ready`
- `degraded` — handshake succeeded but a non-critical subsystem reported unhealthy (for example, FTS index rebuild in progress).
- `crashed`
- `unresponsive` — missed N heartbeats.
- `incompatible`
- `shutting_down`
- `stopped`

Transitions are logged as host events and exposed in a debug panel.

### Heartbeat

- Host pings `PING { seq }` every 5 seconds.
- Sidecar replies `PONG { seq, load_stats }`.
- Three consecutive misses flips state to `unresponsive`. Recovery attempts begin.

### Crash Recovery

When sidecar enters `crashed` or `unresponsive`:

1. Host marks all live blocks as `detached` in the UI immediately.
2. Host invokes the platform-specific crash handler to surface a toast.
3. Host spawns a new sidecar instance.
4. New sidecar replays the event log and rebuilds projections.
5. PTY re-attach is **not** attempted in Phase 1. Any live child processes that were under the old sidecar's PTY master are lost; their blocks stay in `detached` state forever with an explanatory field.
6. Host reconnects UI to the new sidecar and resumes emitting new input as a fresh session.

Opinion: PTY handoff across sidecar crashes is a rabbit hole. Phase 1 keeps the crash story brutally simple so the implementation ships; Phase 3+ can explore handoff via fd-passing if data shows it matters.

### Orphaned Sessions

A session is orphaned when:

- The host disconnects without a clean `GOODBYE`.
- A stale `sidecar.lock` file exists on startup with a pid that is no longer alive.

On sidecar startup, orphaned sessions are marked `recovered_from_crash: true` and their blocks sealed into terminal states (`detached` if they were `running`). The event log remains intact; only the live-process facade is torn down.

### Concurrent Hosts

- One sidecar instance per user profile. Enforced with an advisory file lock on `sidecar.lock` inside the storage root.
- A second host that finds the lock held by a live process connects to the existing sidecar instead of spawning a new one.
- A second host that finds a stale lock (pid not alive) takes over and spawns.
- No multi-profile support in Phase 1.

### Upgrade Path

- On host upgrade, host ships a new sidecar binary with a new `protocol_version`.
- First run after upgrade: host kills the old sidecar cleanly, spawns the new one, new one replays old events via a migration chain.
- Migration chain: each sidecar version knows how to read its own schema and the immediately previous one. Upgrades spanning more than one step either run sequentially in-process or refuse to upgrade and ask the user to update more frequently.

Opinion: do not try to support "read any historical schema." Keep the migration window to N-1 and you avoid a carrying a growing graveyard of migration code.

### Shutdown

- Host sends `GOODBYE { reason }`.
- Sidecar flushes pending writes, closes PTYs gracefully (`SIGHUP` then wait, then `SIGKILL` after a bounded timeout), persists shutdown marker.
- Shutdown marker absent on next start → crash recovery path.

### Host Events for Observability

The host emits (separately from core events, for debugging):

- `host.start_core`
- `host.hello_sent`
- `core.ready`
- `core.incompatible`
- `core.degraded`
- `core.heartbeat_missed`
- `host.restart_core`
- `core.replay_started`
- `core.replay_completed`
- `host.goodbye_sent`
- `core.stopped`

These events feed the debug panel and any support bundle export.

## Consequences

- Support bundles include the host event timeline. Reproducing "it won't connect" gets concrete.
- A visible "core status" indicator is a Phase 1 UI requirement, not a stretch goal.
- Every long-running operation in the sidecar must be crash-safe via the event log. If it is not in the log, it did not happen.
