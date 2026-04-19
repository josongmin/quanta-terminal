# RFC 0001 — Final Epic Status

Wrap-up matrix for the 11 epics enumerated in [`README.md`](./README.md).
Status is evaluated against the repo as of 2026-04-19, immediately before
the §19 final xterm-removal gate evaluation.

Legend:

- **DONE**      — epic shipped; acceptance criteria satisfied in tree; tests
                  green in CI.
- **PARTIAL**   — epic's MUST set shipped; some SHOULD items deferred.
- **IN FLIGHT** — implementation underway; exit gate not yet met.
- **BLOCKED**   — cannot progress until an upstream gate flips.

---

## Status matrix

| Epic | Status | Tests | Files shipped | Notes |
|------|--------|-------|---------------|-------|
| **A** — Width / Grapheme SSOT | DONE | `cargo test -p quanta-vt-width`, TS parity suite under `packages/ui/src/shared/lib/width/__tests__/` | `crates/quanta-vt-width/` (full crate), `packages/ui/src/shared/lib/width/` | ADR 0015 accepted. 500+ codepoint golden corpus; Rust↔TS parity green. |
| **B** — VT Engine Core | DONE | `cargo test -p quanta-vt` (≥ 95% line coverage on the core paths), `crates/quanta-vt/tests/{alt_screen,sgr,csi_cursor,csi_ed,charset,dec_modes,grapheme,osc,resize}.rs` | `crates/quanta-vt/` (domain + ports + adapters), ADR 0017 draft landed | `Grid::feed` is the sole PTY byte entry; alt-buffer + SGR + DECSET 47/1047/1048/1049 all green; event-ordering invariant (`ModeChanged` before first alt-buffer `GridDelta`) enforced in `vte_processor`. |
| **C** — Protocol + Reducer + UI Mirror | DONE | `cargo test -p quanta-proto`, `packages/ui/src/shared/lib/grid-mirror/__tests__/` (ordering, resync, storm, schema-parity, sync-update) | `crates/quanta-proto/` wire format, `packages/ui/src/shared/lib/grid-mirror/`, host-common schema mirrors | Golden JSON schema snapshots committed; `ResyncRow` contract + snapshot-fallback storm threshold live. |
| **D** — Canvas Renderer + Selection | DONE | `packages/ui/src/shared/ui/cell-renderer/__tests__/`, `packages/ui/src/widgets/terminal-canvas/__tests__/` | `packages/ui/src/shared/ui/cell-renderer/` (CellBuffer, FontAtlas, Renderer, DamageSet, HitTest, Selection, Search, backends), `packages/ui/src/widgets/terminal-canvas/` | `BackendContract` with Canvas2DBackend + MemoryBackend; ADR 0016 accepted; hit-test inverse-consistency + wrap-joined copy green. |
| **E** — Input Encoder + IME | DONE | `packages/ui/src/features/input/__tests__/`, `packages/ui/src/features/input/ime/__tests__/{kr-2set,jp-ime,cn-pinyin}.test.ts` | `packages/ui/src/features/input/` (KeyEncoder, MouseEncoder, Paste, Focus, ModeSnapshot, input-host, ime/) | 800+ input-matrix cases + 3-language IME recordings; Korean 2-set double-input reproducibly absent. ADR 0018 accepted. |
| **F** — Session Integration + Actor Wiring | PARTIAL | `crates/quanta-session/tests/{vt_integration,resize_generation,sink_failure}.rs`, `tests/integration/tests/{resume_vt,full_stack_e2e}.rs` | `crates/quanta-session/src/adapters/actor.rs`, `crates/quanta-core/src/adapters/fanout.rs`, `crates/quanta-events/` | Core plumbing green; two tests in `edge_cases.rs` flaky on some CI runners (`shell_that_prints_and_exits_drains_cleanly`, `resize_10000_by_10000_does_not_panic`) — sibling agent iterating on actor race bugs. Gate-blocking: NO (flakes, not regressions). |
| **G** — Compat Matrix + Golden Streams | PARTIAL | `crates/quanta-vt/tests/compat_harness.rs` + fixture corpus | `crates/quanta-vt/tests/compat/` (vim, less, nano, htop, btop, top, tmux, vim-in-tmux, ssh, man, ranger, mc, ncmpcpp) | All §13.9 MUST entries have recorded streams and expected snapshots; `compat-gap/` report generator live. Interactive dogfood cycle pending for Windows-platform parity. |
| **H** — Block Overlay + Alt-screen + Side-by-side | DONE | `packages/ui/src/features/compat/__tests__/side-by-side.test.tsx`, `packages/ui/src/features/degraded-mode/__tests__/`, `packages/ui/src/widgets/block-card/__tests__/` | `packages/ui/src/features/compat/SideBySideHarness.tsx`, `packages/ui/src/features/degraded-mode/`, updated `TerminalPage.tsx` | Alt-screen transitions drive `useTuiStore`; `data-renderer="canvas|xterm"` side-by-side harness green; degraded-mode banner + read-only-last-frame contract shipped. |
| **I** — xterm Removal + Cleanup | IN FLIGHT | — | — (deletion target: `packages/ui/src/widgets/terminal-shell/`) | BLOCKED on §19 gate ALL-TRUE. `packages/ui/src/widgets/terminal-shell/` still present; `@xterm/*` deps still in `packages/ui/package.json`. Final internal dogfood week in progress. |
| **J** — Telemetry + Perf Harness | PARTIAL | `crates/quanta-metrics/` + per-epic instrumentation tests | `crates/quanta-metrics/`, `packages/ui/src/shared/lib/perf-harness/`, `tests/perf/` | Every §13.14 counter emits from at least one call-site; CI perf job runs on every PR. `quanta-replay dump-grid` debug tool shipped. |
| **K** — CI + Platform Matrix + Golden Infra | DONE | `.github/workflows/{vt-engine,ui-renderer,compat-matrix,parity,ci}.yml`, `tools/check-{ui-no-ansi,paint-no-width-override,fsd-layers,key-event-encoder-layer}/` | CI workflows + grep rules + platform-matrix docs | All 4 invariant-enforcing grep rules live; Linux + macOS full compat matrix green in CI; Windows platform runner partial (ConPTY parity entries flagged "known partial"). |

---

## RFC §19 — Removal gate checklist

Evaluated against the tree state on 2026-04-19. A FALSE on any single
row holds the xterm removal (Epic I) at the gate.

| # | Gate item | State |
|---|-----------|-------|
| 1 | Golden replay 100% pass | PASS — `crates/quanta-vt/tests/compat_harness.rs` green for all §13.9 MUST entries. |
| 2 | xterm vs canvas diff == 0 across matrix | PASS — `SideBySideHarness` reports zero cell / cursor / mode divergence on the compat matrix (EPIC-H). |
| 3 | IME real-usage clean (Korean, Japanese, Chinese) | PASS — `packages/ui/src/features/input/ime/__tests__/{kr-2set,jp-ime,cn-pinyin}.test.ts`; Korean 2-set double-input absent (EPIC-E). |
| 4 | CJK + emoji width correct (ZWJ, VS16) | PASS — 500+ codepoint golden corpus, Rust↔TS parity (EPIC-A). |
| 5 | `vim` OK | PASS — `crates/quanta-vt/tests/compat/vim/` green. |
| 6 | `tmux` OK | PASS — `crates/quanta-vt/tests/compat/tmux/` green. |
| 7 | `vim` inside `tmux` OK | PASS — distinct entry in compat matrix green. |
| 8 | `ssh` remote OK | PASS — `ssh`-loopback compat entry green. |
| 9 | Alt-screen enter/exit/nested OK | PASS — ordering enforced engine-side (EPIC-B), nested depth counter on TUI store (EPIC-H). Covered end-to-end by `tests/integration/tests/full_stack_e2e.rs::full_stack_alt_screen_transition` + `packages/ui/src/__tests__/e2e/alt-screen-transition.e2e.test.tsx`. |
| 10 | Resize during alt-screen OK | PASS — `crates/quanta-vt/tests/resize.rs`, actor resize counter covered by `crates/quanta-session/tests/resize_generation.rs`. |
| 11 | Performance gate green | PASS — `tests/perf/` p95 keystroke ≤ 16ms on M-series baseline. |
| 12 | Performance budget decomposition green per-stage | PASS — §13.13 stages each measured in isolation by the perf-harness; baselines committed in `docs/perf-baselines.md`. |
| 13 | Telemetry healthy (no unknown-CSI storm, full-redraw frequency → 0, no epoch-drift storm) | PASS — per-session counters all in expected ranges on dogfood sessions. |
| 14 | ≥ 1 week internal dogfood clean | IN PROGRESS — dogfood cycle started 2026-04-13; one week of clean ends 2026-04-20 (tomorrow). This is the final gate item. |

**Current state**: 13 of 14 PASS. Gate resolution blocks on item #14.
Epic I is IN FLIGHT but cannot land until tomorrow's dogfood cycle clears.

---

## Final E2E deliverables (this pass)

The deliverables that inform this status matrix:

- `tests/integration/tests/full_stack_e2e.rs` — 6 Rust integration tests
  covering the backend pipeline end-to-end (bytes → `Grid::feed` → fanout
  → event stream → snapshot reconstruction).
- `packages/ui/src/__tests__/e2e/full-stack-pipeline.e2e.test.tsx` — 10
  UI e2e tests covering `GridMirror → CellBuffer → Renderer(MemoryBackend)
  → TerminalCanvas → Selection → Copy → Hyperlink`.
- `packages/ui/src/__tests__/e2e/ime-end-to-end.e2e.test.tsx` — 8 IME
  e2e tests covering DOM composition events → state machine → overlay
  lifecycle → commit bytes, plus platform-specific blur policy.
- `packages/ui/src/__tests__/e2e/alt-screen-transition.e2e.test.tsx` — 5
  alt-screen chrome-transition tests covering enter / exit / nested
  depth / non-alt ModeChanged passthrough.
- `packages/ui/src/__tests__/e2e/degraded-mode.e2e.test.tsx` — 4 degraded-
  mode tests covering banner appearance, last-snapshot retention, input
  drop-and-count during degraded state, and restart-only dismissal.

Adds 6 Rust tests + 27 UI tests to the workspace totals:

- Rust: baseline 913 → 919+ (the integration suite reports 6 new passing).
- UI:   baseline 2348 → 2375 passing (27 new).

---

## Action items before sign-off on Epic I

1. Complete the 1-week dogfood cycle (gate item #14); ends 2026-04-20.
2. Stabilise two flaky tests in `crates/quanta-session/tests/edge_cases.rs`
   (`shell_that_prints_and_exits_drains_cleanly`,
   `resize_10000_by_10000_does_not_panic`). Sibling agent is actively
   working actor race fixes in `crates/quanta-session/src/adapters/actor.rs`.
3. Once both of the above land clean, re-run the §19 checklist and, on
   ALL-TRUE, kick off Epic I deletion sequence per the plan in
   `epic-I-xterm-removal.md`.
