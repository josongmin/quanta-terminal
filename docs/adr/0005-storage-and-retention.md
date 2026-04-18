# ADR 0005 — Storage and Retention

## Status

Accepted for Phase 1. Names concrete defaults for storage layout, workspace scoping, retention, and delete semantics.

## Context

The technical architecture picks SQLite + FTS5 + append-only event log + blob spill. That is the right substrate. It does not answer: where on disk, scoped how, kept for how long, deleted how completely. Those are product decisions that become painful to change once a user base exists.

Opinion: workspace-scoped history by default is the single most important call here. "What did I run in this repo" is the question users actually ask.

## Decision

### Storage Root

- macOS Extension host: `~/Library/Application Support/Quanta/profiles/default/`
- Linux Extension host: `$XDG_DATA_HOME/quanta/profiles/default/`, fall back to `~/.local/share/quanta/profiles/default/`
- Tauri desktop: same locations, same layout. The storage root is host-independent so both modes can read the same history.

Layout under the profile root:

- `events/YYYY-MM/seg-NNNN.log.zst`
- `db/quanta.db` (SQLite + FTS5)
- `blobs/sha256/ab/cdef…` for spilled large outputs, content-addressed
- `sidecar.lock`
- `manifest.json` — schema version, sidecar version, workspace registry

### Workspace Scoping

- Every session is bound to a workspace fingerprint at creation.
- Fingerprint priority: (1) git remote URL of the workspace root, (2) absolute path hash if no git remote.
- Fingerprints never change; rename a folder and you get a new workspace unless it shares a git remote.
- Default search and history views filter on the current workspace.
- A "global history" surface is available but gated behind an explicit UI control.

Opinion: branch-level context is overkill. Most users carry knowledge across branches in the same repo; partitioning by branch splits the history they want unified.

### Blob Spill

- Inline output persisted in SQLite up to 1 MiB per span.
- Larger spans spill to `blobs/` as zstd-compressed content-addressed files, referenced from the span row.
- Spill threshold is a config key with sane default. Per-block hard cap on total retained output: 256 MiB. Overflow truncates with a `truncated_at_bytes` field; PTY flow to the UI is never blocked by this cap.

### Retention Defaults

- Unpinned blocks: retained for 90 days after completion.
- Pinned blocks, blocks with labels, blocks linked to saved actions: retained indefinitely.
- Blobs are garbage-collected after their last referencing block is removed.
- Retention is configurable per workspace; global default is written once and editable.

### Delete Semantics

Two-stage delete:

1. **Soft delete** (user-initiated or retention-triggered). Row flagged `deleted_at`. Hidden from UI and search. Recoverable for 7 days from a trash view.
2. **Hard delete**. After the 7-day grace, or on explicit "delete permanently":
   - Block row removed from projection tables.
   - FTS entries removed.
   - Referenced blobs decref'd and garbage-collected.
   - Corresponding event-log entries **not** removed; instead, a tombstone event records the deletion with enough metadata to keep replay coherent. This is the explicit tradeoff: truly removing from the log would break replay; tombstones preserve replay determinism while making projections forget.

Opinion: users who need the event-log truly gone (legal, privacy) get a separate "erase" operation that rewrites the segment containing the event, validated by replay. Not a default operation.

### Corruption Recovery

- On sidecar start, verify `db/quanta.db` integrity pragma and the most recent event segment checksum.
- If DB is corrupt, quarantine it and rebuild projections from events.
- If the latest event segment checksum fails, truncate to the last valid record, log a recovery event, and proceed.
- Rebuilds are background tasks; the sidecar enters `degraded` state while rebuilding but serves PTY flow normally.

### Compaction

- Event segments older than 90 days and containing only tombstoned blocks are compacted away.
- Compaction produces a new segment; the old one is kept for one further generation before removal (snapshot safety).
- FTS index rebuilt lazily when projection drift is detected.

### Schema Migrations

- Each event carries `schema_version` (per event type).
- Migrations run on startup when the sidecar detects it is a newer version than the manifest records.
- Migration is one-way. No downgrade support.
- Migration N → N+1 is code owned by the sidecar of version N+1. Skipping versions requires running each intermediate migration chain in sequence, performed in-process.

### Encryption at Rest

- Not in Phase 1. The profile root relies on filesystem permissions (user-only mode 0700 on the directory).
- Opt-in OS-keychain-backed encryption listed as Phase 3+ work.
- Secret redaction before persistence (ADR 0006) is the Phase 1 answer to "what if the disk is read."

### Quotas

- Soft quota: 10 GiB per profile. Warning surfaced in UI.
- Hard quota: 20 GiB per profile. New output spills are truncated with a user-visible warning; execution continues.
- Quotas configurable; these are defaults, not enforced maximums.

## Consequences

- Every UI surface that shows "history" reads the workspace filter first.
- Search results label workspace origin when the user is in global-history view.
- "Export session" and "support bundle" must apply ADR 0006 redaction; they read from projections, not raw event log, to benefit from redaction.
- The data model is grep-friendly on disk; power users can inspect `quanta.db` with sqlite3 and the event logs with `zstdcat`.
