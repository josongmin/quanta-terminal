# ADR 0013 — History Search and Relevance

## Status

Accepted for Phase 1. Structured, searchable execution history is one of Quanta's differentiators against Warp. Storage is well-specified (ADR 0005). Retrieval semantics were not, and "whatever SQLite FTS5 returns" is not a product.

## Context

Users run thousands of commands. They re-find them by fragments of command, by error text from the failed block, by the file the error pointed at, by "that one I pinned." Without a relevance contract, every query returns a list sorted by whichever column the SQL happens to use, and the UX is indistinguishable from shell history. Structured history is worth building only if retrieval beats `Ctrl-R`.

Opinion: BM25 on command text plus a small, explicit rerank is the whole story. Heavier ranking models here are a distraction. The signal is strong.

## Decision

### Query Shapes

Users express queries through three surfaces, all backed by the same retrieval pipeline:

1. **Global search box** — free-text query, optional filter chips (exit status, time range, labels, workspace, cwd).
2. **Slash-command palette in the composer** — `@<prefix>` opens a ranked list of past commands, designed for rerun.
3. **Programmatic queries** — the host may assemble context for the optional assist layer; it uses the same retrieval.

All three produce a unified `ranked_block_ref` list.

### Indexed Fields

Per ADR 0005 and technical architecture §10.2, the FTS index covers:

- `command_text` — normalized command string (whitespace collapsed, quotes stripped).
- `output_text` — normalized stdout + stderr, redacted per ADR 0006.
- `diagnostic_text` — concatenated diagnostic messages with their file paths.
- `labels` — user-applied labels.
- `cwd` — exact and trigram.
- Metadata: `exit_status`, `workspace_id`, `session_id`, `started_at`, `kind` (command, tui_session, detached), `pin_state`, `has_diagnostics`, `has_rerun_descendants`.

### Retrieval Pipeline

1. **Filter** — hard filters from chips or implicit defaults (current workspace unless global-history is opted in).
2. **Candidate generation** — FTS5 BM25 query over `command_text`, `output_text`, `diagnostic_text`, `labels`. Top 200 candidates.
3. **Rerank** — apply the relevance formula below.
4. **Group** — collapse near-duplicate commands (see dedup rule) into one result with a count.
5. **Cut** — return top N for the UI (default 20 in global search, 10 in composer).

Latency budget: p95 ≤ 150 ms for top-20 over 10k-block profile, per spec §19.10.

### Relevance Formula

Final score for each candidate:

```
score = w_bm25 * bm25_normalized
      + w_recency * recency_decay(started_at)
      + w_pin * pin_boost
      + w_label * label_match
      + w_diag * diagnostic_signal
      + w_workspace * workspace_match
      - p_dup * dup_penalty
      - p_fail_noise * failure_noise_penalty
```

Default weights (tunable, versioned with the ruleset):

- `w_bm25 = 1.0` — BM25 normalized to `[0, 1]` within the candidate set.
- `w_recency = 0.3` — decay half-life of 7 days; older blocks still rank, they just earn it through match quality.
- `w_pin = 0.5` — flat boost for pinned blocks.
- `w_label = 0.2` — per exact-label match on the query.
- `w_diag = 0.15` — diagnostic text match (people remember the error, not the command).
- `w_workspace = 0.25` — in-workspace boost when searching globally; zero when already filtered.
- `p_dup = 0.1` — per near-duplicate prior to this one in the results.
- `p_fail_noise = 0.05` — small penalty for `exit_status ≠ 0` on recency-only ties, so a rerun of a later success wins over an older failure when the query is equivocal.

Weights are loaded from config and surfaced in the debug panel so users tuning their profile can see what is happening. Changing weights does not invalidate stored data; it re-sorts the next query.

### Dedup Rule

Two blocks are near-duplicates if:

- Normalized `command_text` is identical.
- `cwd` is identical.
- Exit status is on the same side of zero.

Near-duplicates collapse into one result entry showing count and the most recent representative. Expanding the entry lists all occurrences with their timestamps.

Opinion: never dedupe across different exit-status classes. "I ran `cargo test` successfully yesterday" and "I ran `cargo test` failing right now" are not the same result even if the text is.

### Pinned Blocks

Pinned blocks surface in two ways:

- As regular results with `w_pin` boost.
- As a dedicated "Pinned" tab in the search surface, listed by last-used time.

A pinned block always appears in the top results for any query it matches above a minimum BM25 threshold (0.05 normalized). This is the cap on de-prioritization; it keeps the pin promise honest.

### Workspace Scoping Defaults

- Default scope is the current workspace (per ADR 0005).
- Global-history search is opted into via an explicit chip.
- When global-history is active, results include a workspace badge. Results outside the current workspace rank below in-workspace results of similar BM25 score thanks to `w_workspace`.

### Time Range Semantics

Filter chips:

- `last_hour`, `today`, `this_week`, `this_month`, `all`.
- Custom range with explicit `from` and `to` when the user expands the chip.

Default: `all`. Recency is a rank signal, not a hard filter.

### Query Syntax

- Plain tokens → FTS match across indexed text fields.
- `cwd:/path/fragment` → exact cwd trigram filter.
- `status:fail` / `status:ok` → exit filter.
- `label:foo` → label exact match.
- `session:<id>` → session filter.
- `kind:tui` / `kind:detached` → block kind filter.
- `pinned` → pinned-only.
- `has:diagnostic` → non-empty diagnostic filter.
- `since:1d` / `before:2w` → relative time.
- Leading `/` → reserved; route to commands, not search.

Unknown prefixes pass through as plain tokens and the UI shows a soft hint.

### Diagnostic Search

Diagnostics are the most common reason to dig through history ("that EADDRINUSE error last week"). Diagnostic search is first-class:

- Diagnostic messages are indexed.
- A match on `diagnostic_text` marks the hit; UI surfaces the diagnostic snippet under the block header.
- Filter `has:diagnostic:<severity>` narrows to specific severities.
- A diagnostic-click from an error surface can pivot into search on that message ("find other times I hit this").

### Rerun Lineage Traversal

When a block has rerun descendants, the search result shows a "1 of N reruns" affordance. Expanding walks the lineage. Lineage traversal is not part of the primary rank but is one click away from every matching block.

### Relevance Testing

- Judged fixture set: curated (query, expected top result) pairs. Shipped initially with 50 pairs, grown per regression.
- Metric: MRR (mean reciprocal rank) of the expected result in top 10. Target: MRR ≥ 0.9 on the fixture set.
- Blind A/B of weight changes against the fixture set before merging to main.

### Privacy and Redaction

- Search queries are not persisted.
- Results render redacted representations per ADR 0006.
- The search index itself is built over redacted text, so a secret that was redacted at persistence time is not searchable by its raw form.

### Non-Goals

- Cross-user shared search.
- Vector embeddings in Phase 1.
- Learned ranker in Phase 1. The default weights and a rule-driven rerank carry the load; revisit after operational data.

## Consequences

- A query returns the same result set across sessions until new data arrives; determinism is a tested property.
- The search debug panel shows the per-component contribution to each result's score. This is a power-user affordance and a support tool.
- The fixture set is maintained alongside the ruleset; any rank regression that fires during Phase 2 parser rollout becomes a fixture.
