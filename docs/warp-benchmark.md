# Warp Benchmark Notes

> **Protocol:** the experiment that turns these notes into numbers lives in [benchmark-protocol.md](./benchmark-protocol.md). This document captures the *posture* — what we measure Warp against and why. The protocol owns *how*.

## Goal

Use Warp as one reference for block-oriented UX, not as the sole product proxy. Quanta's broader benchmark stance sits in [terminal-benchmark-matrix.md](./terminal-benchmark-matrix.md); Warp is the closest product-shape comparison.

## Areas To Match

- PTY trustworthiness
- Command composition ergonomics
- Block readability for common commands
- Rerun ergonomics
- Responsiveness under large output

Matching means "no regression the user can feel." See `benchmark-protocol.md` §7.1 for the operational definition.

## Areas To Exceed

- File and line extraction from compiler, linter, and stack-trace output
- Direct jump from terminal block to editor location
- Return path from editor back to originating terminal block
- Structured execution history as durable, searchable knowledge
- Rerun comparison across outputs, exit status, and duration
- Recovery from sidecar or UI crashes (structural advantage from ADR 0004)

See `benchmark-protocol.md` §7.2 for concrete superiority targets.

## Benchmark Discipline

- No cherry-picked task set.
- Every claim is backed by a committed results file under `benchmarks/results/`.
- Subjective metrics corroborate objective metrics; they do not substitute for them.

## Open Caveats

- Warp evolves rapidly. Results files stamp the Warp version; comparisons across releases must re-run.
- Warp's non-terminal features (collaboration, notebooks) are intentionally out of scope. Quanta does not compete there.
- For pure raw-terminal throughput, Ghostty and WezTerm are the real ceiling. Include at least one of them as a ceiling check on latency-sensitive tasks.
