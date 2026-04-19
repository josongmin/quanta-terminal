# `<program>_<timestamp>.report` — Compat Gap Report

Canonical template for a compat mismatch. The JSON payload below is the
exact shape the harness writes; the surrounding markdown is a thin
human-readable wrapper so an operator can read the report without a
JSON viewer.

Schema version: **1** (see
`docs/plans/0001-custom-vt-engine-xterm-removal/epic-G-compat-matrix.md`
§4.5).

---

## Summary

- **Program**: `<program>`
- **Scenario**: `<scenario id, matches scenario.md title>`
- **Harness**: `replay` | `scripted`
- **Captured at** (UTC): `YYYY-MM-DDTHH:MM:SSZ`
- **Engine commit SHA**: `<git rev-parse HEAD at time of failure>`
- **Input length**: `<bytes>`
- **Event count**: `<events emitted by the engine before the divergence>`

## Diff summary

First divergent observation across grid / cursor / modes:

| Kind | Where | Expected | Actual |
|------|-------|----------|--------|
| cell | row=`R`, col=`C` | `<Cell JSON>` | `<Cell JSON>` |
| cursor | — | `{row, col, visible, shape}` | `{row, col, visible, shape}` |
| mode | `<DecMode variant>` | `<bool>` | `<bool>` |

## Reproduction steps

1. `git checkout <engine_commit_sha>`
2. `cargo test -p quanta-vt --test compat_harness <program>` (replay)
   or `cargo test -p quanta-integration-tests --test compat_scripted <scenario>`
   (scripted, if the failing harness is `scripted`).
3. Observe the same divergence in the regenerated report.
4. If the divergence depends on recording-env drift, reproduce under
   `TERM=xterm-256color LINES=24 COLUMNS=80 TZ=UTC LANG=en_US.UTF-8`.

## Owning phase

Per RFC 0001 §22 failure modes:

- [ ] §22 #1-4, #12-14, #18 — Input encoding (EPIC-E)
- [ ] §22 #5-7 — Width / wrap classifier (EPIC-A)
- [ ] §22 #8-11 — Grid / alt-screen / cursor / DEC modes (EPIC-B)
- [ ] §22 #16 — Wire protocol (EPIC-C)
- [ ] §22 #19-20 — Renderer backend (EPIC-D)
- [ ] §22 #15 — SSH slow link (EPIC-J perf harness)
- [ ] §22 #17 — Engine crash mid-alt-screen (EPIC-H degraded mode)
- [ ] General seam — catch-all owned here (EPIC-G)

## Resolution

- [ ] Engine bug — fix lands; re-run passes; move to `resolved/`.
- [ ] Fixture stale — re-record, bump `VERSIONS.md`; move to `resolved/`.
- [ ] Env drift — document canonical env in
  `scripts/record-compat-stream.sh`; re-record; move to `resolved/`.
- [ ] Deferred — rationale + tracking issue; move to
  `resolved/<program>_<ts>_deferred.md`. RFC §19 removal gate remains
  blocked.

## JSON payload

```json
{
  "schema_version": 1,
  "program": "<program>",
  "scenario": "<scenario id>",
  "timestamp_utc": "YYYY-MM-DDTHH:MM:SSZ",
  "harness": "replay",
  "engine_commit_sha": "<sha>",
  "fixture": {
    "input_len_bytes": 0,
    "event_count": 0
  },
  "diffs": [
    {
      "kind": "cell",
      "row": 0,
      "col": 0,
      "expected": { "grapheme": "h", "width": "one", "fg": { "kind": "default" } },
      "actual":   { "grapheme": "",  "width": "one", "fg": { "kind": "default" } }
    },
    {
      "kind": "cursor",
      "expected": { "row": 0, "col": 5 },
      "actual":   { "row": 0, "col": 4 }
    },
    {
      "kind": "mode",
      "mode": "AltScreenFull",
      "expected": true,
      "actual": false
    }
  ],
  "versions_md_excerpt": "<copy of the program's VERSIONS.md row at failure time>"
}
```
