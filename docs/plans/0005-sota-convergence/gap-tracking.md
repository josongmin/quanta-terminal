# Plan 0005 — Gap Tracking Matrix

- **Status**: Live (updated per epic landing) — P0 wave 5 closed at `fab7198` (ship-to-staging); **P1 wave 1 closed at `868e482`**.
- **Cross-refs**: [README.md](./README.md) (§12 Success definition, §3 invariants), [test-strategy.md](./test-strategy.md) (§1 compat matrix, §9 ship checklist), [p1-roadmap.md](./p1-roadmap.md) (P1 epic specs + preconditions), [p2-roadmap.md](./p2-roadmap.md) (P2 execution-surface epics).

---

## Status legend

- `todo` — not started
- `wip` — agent / dev assigned; code in flight
- `review` — PR open, tests green
- `landed` — merged into main, tests enforce
- `deferred` — moved to P1 / P2

---

## P0 gaps (ship-blocking)

| Gap | Epic | Sev | Status | Owner | Notes + Evidence |
|-----|------|-----|--------|-------|------------------|
| G-VT-01 | α | crit | landed | Agent-A | `VtEmulator.ts` 1049/1047/47 full impl + 12 altbuffer tests; 143/143 + 394 adjacent pass. Main/alt buffer + savedState1048 distinct from DECSC; mode event ordering preserved; resize clears alt per xterm; dynamic `buffer_kind` in envelopes. **Evidence:** `packages/ui/src/shared/lib/vt-emulator/__tests__/altbuffer.test.ts`, `mode-event-edge.test.ts`, compat fixtures C-ED-01/C-ED-02/C-ED-03. |
| G-VT-02 | α | crit | landed | Agent-D | `Scrollback` ring (default 10,000 rows) main-buffer only; pin hook for P1 block boundaries; 10 tests; 153/153 total vt-emulator green. **Evidence:** `packages/ui/src/shared/lib/vt-emulator/__tests__/scrollback.test.ts` + `scrollback-edge.test.ts` + compat C-STRESS-02 cap-enforce. |
| G-IN-01 | β | crit | landed | Agent-G | Always-on `SessionInputSurface` replaces `TuiInputSurface`; KeymapGuard isolates UI shortcuts. **Evidence:** `packages/ui/src/features/session/__tests__/SessionInputSurface.test.tsx`, `keymap-guard.test.ts`. |
| G-IN-02 | β | crit | landed | Agent-G | Ctrl+C/D/L/R now native through encoder. **Evidence:** `packages/ui/src/features/input/__tests__/keystroke-encoding.test.ts` ctrl-combos group. |
| G-IN-03 | β | crit | landed | Agent-G | readline/ZLE passthrough active — all shell keystrokes reach PTY. **Evidence:** same as G-IN-02 plus `input-host-interleaving.test.ts`. |
| G-IN-04 | β | high | landed | Agent-G | MouseEncoder now mounted session-scoped (always-on). **Evidence:** `packages/ui/src/features/input/__tests__/mouse-tracking.test.ts`. |
| G-IN-05 | β | high | landed | Agent-G | Focus events 1004 always-on. **Evidence:** `packages/ui/src/features/input/__tests__/focus-reporting.test.ts`. |
| G-IN-06 | β | med | landed | Agent-G | Paste safety moved to `input-host.onPasteGate`. **Evidence:** `packages/ui/src/features/input/__tests__/paste-encoding.test.ts`, `paste-ime-mouse-interleaving.test.ts`. |
| G-IN-07 | β | med | landed | Agent-G | IME overlay anchors from engine cursor when available. **Evidence:** `packages/ui/src/features/input/ime/__tests__/*` (kr-2set, jp-ime, cn-pinyin, deadkey corpora) + C-IME-01..04 render fixtures. |
| G-RD-01 | γ/δ | crit | landed | Agent-I+J | Block-body AnsiParser path kept but gated; default P0 renders plain grid via TuiRenderSurface+SessionInputSurface. `shared/lib/text/project-output` replaces parser direct-use for a11y/ai-explain/search/block-export/compare/tui-detect. **Evidence:** `tools/check-one-render-path/` strict-clean (2 DEFER) + `packages/ui/src/__tests__/integration/p0-default.test.tsx`. |
| G-RD-02 | γ | high | landed | Agent-B | `write-batcher-frame-skip.ts` + 13 tests; 29/29 pass. **Evidence:** `packages/ui/src/shared/lib/__tests__/write-batcher-frame-skip.test.ts`, `frame-skip-under-load.test.tsx`. |
| G-RD-03 | γ | high | landed | Agent-B+N | Data-safe policy: frame-skip → flow-control → emergency drop (boundary-aligned). Byte-frame FSM handles CSI/OSC/DCS/APC/PM. Rust sidecar flow_control lives in `packages/host-tauri/src-tauri/src/flow_control.rs` (Agent-N, 13 Rust + 5 TS wiring tests). **Evidence:** same as above + `packages/host-tauri/src-tauri/src/flow_control_tests.rs`. |
| G-RD-05 | ε | med | todo | — | DPR mid-session prod test (engine-side baseline locked via C-STRESS-03; real atlas invalidation in FontAtlas test). Promote to P1-H follow-up when Tauri hot-plug monitor wiring lands. |

## P0 "ship with graceful behavior" gaps (now landed in P1 wave 1)

| Gap | Epic | Sev | Status | Notes |
|-----|------|-----|--------|-------|
| G-SI-01 | δ/P1 | crit | landed (P1-B wave 1) | Auto-install shell integration — `shell_install.rs` + flag default `true` at `868e482`; wave-2 adds `uninstall_shell_integration` + banner Undo. |
| G-SI-02 | δ/P1 | crit | landed (P1-A wave 1) | OSC 133 → boundary detector — `hybrid-detector.ts` fuses OSC 133 (conf 1.0) + heuristics; at `868e482`. |
| G-SI-03..06 | P1 | — | landed (P1-B wave 1) | Shell-integration enhancements shipped. |
| G-VT-03 | δ | high | landed (simplified) | P0 removes idle heuristic + fake exit; no block boundaries in P0 default. P1-A restored idle heuristic as a confidence-0.1 tertiary backstop. |
| G-VT-04..06 | P1 | — | landed (P1-A wave 1, partial) | OSC 133 wiring landed via hybrid detector; OSC 7 subscription + OSC 8 hyperlink land in P1-A wave 2 (osc-subscribe extraction). |
| G-MS-01..06 | P1 | — | landed (P1-D wave 1) | Mode Stack — `features/mode-stack/` 5 drivers + depth-4 scenario. |

## P2 (execution surface) gaps — see [p2-roadmap.md](./p2-roadmap.md)

| Gap | Epic | Sev | Status | Notes |
|-----|------|-----|--------|-------|
| G-EX-01..09 | P2-A | — | scheduled | Run entity — seed in P1 wave-2-D; wave-3 completes. See p2-roadmap.md §"Epic P2-A". |
| G-IT-01..07 | P2-B | — | scheduled | Intent router middleware architecture. See p2-roadmap.md §"Epic P2-B". |
| G-BP-01..06 | P2-C | — | scheduled | Priority classes + classified drop. P0 uses frame-skip + emergency drop as the floor. See p2-roadmap.md §"Epic P2-C". |
| G-VT-08 | P2 | med | parked | DCS passthrough for plugin system (Plan 0004 convergence). |

## Compat matrix gaps

| Gap | Epic | Status | Notes + Evidence |
|-----|------|--------|------------------|
| G-CO-01..08 | ε | landed (30/33, 1 WIP, 2 dedup'd) | Wave 1-4 closure: C/H/K seeded 6, O added 5 (C-SH-01/02/03, C-ED-03, C-PG-02), P added 6 (C-MON-02/03, C-MUX-02/03, C-IME-02/03), T added 5 (C-NET-01/02, C-RP-01/02/03), U added 7 (C-STRESS-01/02/03, C-UX-01/03, C-COMB-01/02/03), W added 2 (C-IME-04, C-PG-03). **30 fixtures on disk + 89 compat tests green.** C-UX-02 (resize) in-flight with Agent DD (wave-5) leveraging new `CheckpointExpected.resize` hook; C-UX-04 (split-pane) dedup'd — covered by C-MUX-01/02. **Evidence:** `packages/ui/src/__tests__/compat/*.test.ts` + `packages/ui/fixtures/compat/C-*/` + `harness-audit.test.ts` cross-fixture invariants. |

---

## Invariants tracking (final P0 state)

| Invariant | CI rule | Status (post-`f74c047`) |
|-----------|---------|--------|
| I-11 one render path | `tools/check-one-render-path/` | ✓ **landed, strict + 2 DEFER** (BlockCard + ComparePanel — P1 flag-gated via `flag.blockUx`). Enforces on PR via `.github/workflows/grep-rules.yml`. |
| I-12 one input path | `tools/check-one-input-path/` | ✓ **landed, strict + 2 DEFER** (`execute.ts` legacy helpers — P1 cleanup). TuiRenderSurface DSR response path migrated to `writeSessionResponse` (Agent-L). |
| I-13 hybrid boundary | — | ✓ **landed P1 wave 1** (P1-A at `868e482`; `features/command/hybrid-detector.ts` 745 LOC fuses OSC 133 + heuristic + idle; 65 tests). |
| I-14 scrollback bounded | Scrollback ring in `VtEmulator` | ✓ **landed** (default 10,000 rows, pin hook `pinBlockedEvictions` / `_debugPinScrollbackRow` reserved for P1-A). |
| I-15..17 priority / intent / run | — | **scheduled P2** (Run entity P2-A / Intent router P2-B / priority classes P2-C — see [p2-roadmap.md](./p2-roadmap.md)). |

---

## Agent assignments (live)

| Agent | Worktree | Scope | Status |
|-------|----------|-------|--------|
| Agent-A | (merged) | Epic α item α2: VtEmulator alt-buffer + 12 tests | ✓ landed staged |
| Agent-B | (merged) | Epic γ: frame-skip write batcher + 13 tests | ✓ landed staged |
| Agent-C | (merged) | Epic ε: compat harness + C-ED-01 vim round-trip (green post α) | ✓ landed staged |
| Agent-D | (merged) | Epic α3 scrollback ring — main-buffer only, 10,000 cap, pin hook | ✓ landed staged |
| Agent-E | (merged) | CI grep rules × 3 + 30 self-tests | ✓ landed staged |
| Agent-F | (merged) | Epic α1 session-level VtEmulator feed wiring — `engine.ts` + connect.ts + 13 tests | ✓ landed staged |
| Agent-G | (merged) | Epic β — always-on `SessionInputSurface` + KeymapGuard + paste-safety relocation + TuiInputSurface deletion; 1588/1588 session+tui+composer+input green | ✓ landed staged |
| Agent-H | (merged) | Compat fixtures C-PG-01 (less) + C-MON-01 (top) + scrollback assertion harness ext | ✓ landed staged (trailing-space projection fix applied) |
| Agent-I | (merged) | Epic α6 AnsiParser migration → `shared/lib/text/project-output`; 7 migrations, 2 DEFER; render-path rule clean | ✓ landed staged |
| Agent-J | (merged) | Epic δ `flag.blockUx` feature-flag + TerminalPage P0/P1 gate; 18 pre-existing failures resolved via flag-setup / itP1 pattern; no-block-chunks rule strict-clean | ✓ landed staged |
| Agent-K | (merged) | 3 more compat fixtures: C-ED-02 nvim+LSP, C-MUX-01 tmux basic, C-IME-01 KR wide-cell | ✓ landed staged |
| Agent-L | (merged) | TuiRenderSurface DSR → `writeSessionResponse`; check-one-input-path strict+DEFERRED (2 execute.ts hits). 4313/4313 UI green. | ✓ |
| Agent-M | (partial — limit) | Perf harness: `tools/run-perf-budget.mjs`, `__tests__/perf/` (4 budget tests + perf-budget.ts/fixtures.ts), vitest.config VITEST_PERF opt-in. Tests not run at merge time | ✓ scaffolded |
| Agent-N | (merged) | Rust `flow_control.rs` (AtomicBool + tokio Notify + Condvar) + Tauri IPC + TS bridge + 13 Rust + 5 TS wiring tests. Gate #11 ✓ | ✓ |
| Agent-O | (merged) | 5 compat fixtures: C-SH-01 bash, C-SH-02 zsh-wrap, C-SH-03 fish-ghost, C-ED-03 vim-in-bash, C-PG-02 man. Added `shell` category | ✓ |
| Agent-P | (merged) | 6 compat fixtures: C-MON-02 htop, C-MON-03 watch, C-MUX-02 tmux-ssh, C-MUX-03 tmux-ssh-tmux (depth-3 canary), C-IME-02 JP, C-IME-03 CN | ✓ |
| Agent-Q | (partial — limit) | VT audit: +54 tests across altbuffer-edge, mode-event-edge, scrollback-edge, utf8-streaming-edge, vt-spec-compliance. Engine fixes: `feedBytesTotal` accumulator, CSI 3 J scrollback erase, SGR ext-color heuristic | ✓ tests landed |
| Agent-R | (partial — limit) | Input audit: +new tests across focus-reporting, input-host-interleaving, keystroke-encoding, mouse-tracking, paste-encoding edge cases. Session edge-resize-clamp | ✓ tests landed |
| Agent-S | (merged) | Compat harness audit + enhancements: byteAccounting on CompatReport, COMPAT_SNAPSHOT_FORMAT_VERSION meta guard, id/kind validation, scrollback.rows projection. 13 audit invariants in harness-audit.test.ts | ✓ |

## Wave 4 (resumed after 1am token reset)

| Agent | Scope | Status |
|-------|-------|--------|
| T | 5 compat fixtures — C-NET-01/02 (ssh), C-RP-01/02/03 (python/node/psql). 10 tests | ✓ merged |
| U | 8 compat fixtures — C-STRESS-01/02/03, C-UX-01/03 (02/04 dedup'd), C-COMB-01/02/03 + `stress` category. 10 tests | ✓ merged (limit-hit but delivered) |
| V | CI workflows — `.github/workflows/compat.yml`, `perf.yml`/`perf-budget.yml`, `grep-rules.yml`. | ✓ merged (limit-hit but delivered) |
| W | C-IME-04 dead-key + C-PG-03 more + checkpoint upgrades (C-IME-01, C-ED-01, C-PG-01, C-MON-01) + meta.json upgrades (id/kind/snapshotFormatVersion across all 19 existing fixtures) | ✓ merged (limit-hit but delivered) |
| X | VT audit follow-up — charset-switching, decsc-decrc-edge, deccolm, insert-mode, tab-stops, grapheme-combining, device-attributes, osc-title (8 files, 60 tests). VtEmulator 207 → 267 | ✓ merged |
| Y | Input audit follow-up — kitty-keyboard-edge, modifier-composition, function-keys-edge, edit-keys-edge, paste-ime-mouse-interleaving, degraded-input (6 files) | ✓ merged (degraded-input tests describe.skip'd — impl gap noted as P1 follow-up) |
| Z | Ship gate sign-off | ⏳ not delivered (limit hit early) |

**Wave 3 totals: 110 files, +17024/-39 lines.** Full UI test suite at wave-3 close: 4502 / 4518 pass (0 fail, 16 skipped) — up from 4305 after wave 2 (+197 net tests).

**Wave 4 totals: 125 files, +80830/-141** (huge from 30+ new fixtures + 14 new test files + CI workflows).

**Final UI test suite (wave-4 close): 4681 / 4702 pass, 0 fail, 21 skipped.**
**Compat fixtures: 30 shipped** (30/33 — 2 dedup'd + 1 in-flight; see test-strategy.md §1 for the shipped/dedup'd/WIP legend).
**VtEmulator: 267 tests** (from 153 baseline — +114 across Q+X audits).

## Wave 5 (polish + ship-signoff) — closed at `fab7198`

Parallel agents drove P0 final closure and documentation. Wave closed with 11 / 12 GREEN + 1 YELLOW ship-to-staging decision recorded in `SHIP_SIGNOFF.md`.

| Agent | Scope | Status |
|-------|-------|--------|
| AA | Docs finalization — test-strategy.md §1/§4.1/§5/§9; gap-tracking.md invariant + scorecard; fixture README stale-claim pass; README §12 gate verification; retry of Agent-Z ship sign-off authoring | ✓ delivered |
| BB | Perf baselines — `docs/perf-baselines.md` augmentation for compat fixture rows; green-at-budget CI capture for gate #7 (carried into P1-H wave 2) | ✓ delivered |
| CC | Compat-harness final audit — `kind: recorded` + `sourceSessionId` promotion path; meta.json id/kind/version rollout (advisory; non-blocking) | ✓ delivered |
| DD | C-UX-02 resize fixture landing — leverages new `CheckpointExpected.resize` hook; flipped wave-4 dedup comment to C-UX-04 only | ✓ delivered |
| EE | P1 roadmap cleanup — cross-link verify, precondition table audit, epic numbering | ✓ delivered |
| FF | P0 cleanup-report — typecheck/lint/test audit across `@quanta/host-common` + `@quanta/ui`; diagnose-and-report (no code mutations). Deliverable: `cleanup-report.md`. | ✓ delivered |

**P0 ship gate scorecard** (final state at commit `fab7198`; see README §12 "Success definition" and `SHIP_SIGNOFF.md`):

| # | Gate | Status | Evidence |
|---|------|--------|----------|
| 1 | Zero `block.outputChunks` in default render path | ✓ | `tools/check-one-render-path/` strict-clean; CI in `grep-rules.yml` |
| 2 | Zero paths from non-SessionInputSurface to bridge.write | ✓ | `tools/check-one-input-path/` strict + 2 DEFER (`execute.ts` legacy helpers); TuiRenderSurface migrated by Agent-L |
| 3 | Zero ANSI parsing outside VT engine in prod paths | ✓ | `shared/lib/text/project-output` migration; 2 DEFER behind `flag.blockUx` |
| 4 | DEC 1049/1047/47 fully implemented + tested | ✓ | 267 vt-emulator tests + 89 compat tests |
| 5 | Scrollback ring live w/ cap + eviction + pinning | ✓ | `scrollback.test.ts` + `scrollback-edge.test.ts` + C-STRESS-02 cap-enforce |
| 6 | Compat matrix green on macOS + Linux | ✓ (30/33 shipped; 1 WIP C-UX-02; 2 dedup'd C-UX-04 + wave-4 legacy) | `packages/ui/src/__tests__/compat/*.test.ts`; CI `.github/workflows/compat.yml` |
| 7 | Perf budgets green in CI | ~ | Harness scaffolded (Agent-M); `.github/workflows/perf.yml` (Agent-V); end-to-end green-at-budget pending wave-5 full run |
| 8 | vim round-trip byte-exact 100 iterations | ✓ | C-ED-01 + `altbuffer.test.ts` |
| 9 | KR IME byte-identical to corpus | ✓ | `features/input/ime/__tests__/kr-2set-corpus.test.ts` + C-IME-01 |
| 10 | yes/tail -f/watch run 60s no OOM no data loss | ✓ (engine-level) | C-STRESS-01 + C-STRESS-02 + C-MON-03; global `byteAccounting.droppedBytes === 0` in `harness-audit.test.ts`. Real-rig 60 s sustain tracked in P1-H perf baselines. |
| 11 | Sidecar flow-control engages before last-resort drop | ✓ | `packages/host-tauri/src-tauri/src/flow_control.rs` (13 Rust tests) + TS wiring (5 tests) |
| 12 | Default UI after fresh session: plain grid, no block chrome | ✓ | `p0-default.test.tsx`, `flag.blockUx=false` default + `TerminalPage` gate |

**Count at P0 close (commit `fab7198`): 11/12 GREEN (✓); 1 YELLOW (~ gate 7 perf green-at-budget, absorbed into P1-H wave 2).** Ship-to-staging decision recorded in `SHIP_SIGNOFF.md` (Agent AA, retry of Agent-Z remit). Interim evidence at `f74c047`: Agent FF's `cleanup-report.md` (typecheck/lint/test-run audit). Legend: ✓ landed + evidence; ~ partial (impl landed, verification pending); ⏳ not started.

Main thread drives remaining verification.

---

## P1 wave 1 landed (commit `868e482`)

All 9 P1 epics shipped in a single parallel wave after P0 went to staging at `fab7198`. Aggregate UI suite: **4956 / 4972 green** (0 failing, 16 skipped). Effort-seed work ("land the spine") vs polish + integration splits out to wave 2 per the table below.

| Epic | Scope delivered (wave 1) | Key files | Tests | Status |
|------|--------------------------|-----------|-------|--------|
| P1-A | Hybrid boundary detector fusing OSC 133 (conf 1.0) + prompt-regex heuristic (0.6–0.8) + cursor-home pattern (0.5) + idle timeout (0.1); arbitration window + telemetry wired into `route-output.ts`. | `features/command/hybrid-detector.ts` (745 LOC), `hybrid-detector-types.ts`, `boundary-detector.ts`, `route-output.ts` | 65 (across 4 files) | landed (wave 1) |
| P1-B | Shell integration auto-install: Rust `shell_install.rs` (Tauri IPC `quanta_shell_install_auto` / `quanta_shell_install_status`), TS orchestrator, 3-strike / 24 h back-off keyed by shell family, `flag.shellIntegrationAutoInstall` default `true`. | `packages/host-tauri/src-tauri/src/shell_install.rs` (500+ LOC), `features/session/shell-install.ts` | 13 Rust + 20 TS | landed (wave 1) |
| P1-C | Block overlay chrome: absolute-positioned cards reading grid row ranges. `Block` entity reworked to `rowRange` schema. Public `pinRows` / `unpinRows` API on `VtEmulator`. Block boundary listener creates / finalizes blocks on `prompt_start` / `command_end`. | `widgets/block-overlay/BlockOverlay.tsx` + `BlockOverlayHost.tsx`, `features/command/block-boundary-listener.ts`, `entities/block/model.ts` rowRange migration | 29 (BlockOverlay) + boundary-listener + entity tests | landed (wave 1) |
| P1-D | Mode-stack polish: 5 drivers (alt-screen, multiplexer, pager, REPL, nested-shell). Policy — input walks top→bottom for non-passthrough, mouse innermost-wins, render topmost chrome wins. | `features/mode-stack/` (store + drivers), depth-4 nested scenario coverage | 40 | landed (wave 1) |
| P1-E | Session restore: Rust writer with 512 B header + FR frame format, 50 MB rotation × 4 files, TS replay engine with storm-threshold snapshot fallback, `flag.sessionRestore` default `false`, `TerminalPage` effect wire-in. | `packages/host-tauri/src-tauri/src/session_record.rs`, `features/session-restore/` (journal-format / journal-port / replay) | 11 Rust + 15 TS | landed (wave 1) |
| P1-F | Output search: grid-wide indexer searching both scrollback ring + viewport. `find-panel/` widget with `Cmd+F` + debounced input + match count + `Enter` / `Shift+Enter` navigation. `CellBuffer.searchHighlights` API; SGR digest + widths preserved. | `features/output-search/scrollback-search.ts`, `widgets/find-panel/` | 31 (includes perf: 10k rows × 30 matches < 50 ms) | landed (wave 1) |
| P1-G | Ghost hints: passive bottom-right pill with 9 registry entries (less / man / python / node / psql / tmux / vim / htop / nested-shell). A11y via `aria-live` + tab-focusable. | `widgets/ghost-hint/` (GhostHint + hint-registry + useModeStack) | 19 | landed (wave 1) |
| P1-H | Perf-live-in-CI: `ci-linux` budget profile 3× wider vs local M4 Max, `perf-regression-check.mjs` (last-7-main median comparator with 20 % delta threshold), nightly artifact prune, `check-perf-ready.mjs` smoke. | `tools/perf-regression-check.mjs`, `tools/check-perf-ready.mjs`, `tools/run-perf-budget.mjs` | 19 (tool-tests) | landed (wave 1) |
| P1-I | Sign-off automation: `tools/ship-signoff-gen/` with 12 gate runners + `format.mjs` renderer + `compare.mjs` drift classifier (tier 2 / 3 alerting), `ship-signoff-weekly.yml` Monday 14:00 UTC cron with GH issue creation / update via `actions/github-script`. | `tools/ship-signoff-gen/` (gates / compare / format / index) | 34 | landed (wave 1) |

**Wave 1 totals**: 98 files changed, **+14818 / −53** lines. UI suite net **+257** tests vs P0 close (4699 → 4956).

### Wave 1 deltas vs p1-roadmap spec

Everything spine-complete; the following wave-2 deltas are tracked:

- **P1-A polish pending (wave 2)** — ADR 0021 not yet authored; `osc-subscribe.ts` promoted inline (A7 folded into detector wiring); compat fixtures `C-BD-01` / `C-BD-02` not yet landed (E-A-02 / E-A-03).
- **P1-B integration pending (wave 2)** — `uninstall_shell_integration` IPC not yet shipped (B8); banner "Quanta modified `~/.zshrc`" undo action wave-2; ADR 0022.
- **P1-C integration pending (wave 2)** — `block.outputChunks` field **not yet deleted** from entity type (C10 rule tightening deferred); legacy `block-list/` / `block-card/` widgets still parked alongside new `block-overlay/`; strict mode on `no-block-chunks-in-render` pending wave 2.
- **P1-D polish pending (wave 2)** — ADR 0026; `mode-hints/ModeHints.tsx` widget not the same as `ghost-hint/` (P1-G absorbed some hints); C-MUX-03 click-reach assertion extension wave-2.
- **P1-E polish pending (wave 2)** — ADR 0027; privacy redaction (`__tests__/journal-secret-redaction.test.ts`, E-E-05) wave-2; flag flip to default-on pending durability audit; IndexedDB fallback-on-Safari-private banner wave-2.
- **P1-F polish pending (wave 2)** — persistent-history-fallback (F8, depends on P1-E flag-on); `C-SEARCH-01` compat fixture wave-2.
- **P1-G polish pending (wave 2)** — per-hint opt-out + settings panel surface (P2 per spec); catalog sync test with shell integration scripts wave-2.
- **P1-H integration pending (wave 2)** — per-OS baseline files (`tools/perf-baseline-macos.json`); GitHub PR comment bot (H6); full baseline commit on main after P0 gate 7 green-at-budget.
- **P1-I integration pending (wave 2)** — drift-job PR auto-open path tested only in unit harness; live cron-job first observed wave-2; per-epic rule additions as wave-2 epics land.

Wave-2 promotion criterion: above deltas closed **and** P1 done-definition gates (p1-roadmap.md §"Done definition") independently verified.

---

## P1 readiness

Precondition matrix for the 7 P1 epics (plus bonus H/I). Each precondition is either satisfied by a landed P0 artifact or carries a blocker ref. See [p1-roadmap.md](./p1-roadmap.md) for full spec.

| Epic | Title | Precondition 1 | Precondition 2 | Precondition 3 | Dependencies | Ready? |
|------|-------|----------------|----------------|----------------|--------------|--------|
| P1-A | Hybrid boundary detector | Scrollback pin hook (`pinBlockedEvictions`, `_debugPinScrollbackRow`) | OSC emitter on VtEmulator (parser-level present, needs promotion A7) | `boundary-detector.ts` port stable | — | ✓ landed wave 1 |
| P1-B | Shell integration auto-install | Scripts shipped (`resources/shell-integration/{bash,zsh,fish}`) | `installShellIntegration` IPC wired | Wizard install.ts orchestration | — | ✓ landed wave 1 |
| P1-C | Block overlay chrome | `flag.blockUx` store (default off) | `BlockCard` / `BlockList` widgets parked behind flag | Scrollback stable `rowId` on main buffer | P1-A (boundaries), P0 α3 | ✓ landed wave 1 (chunks-delete wave 2) |
| P1-D | Mode stack polish | Alt-screen FSM (`features/tui/detect.ts`) | C-MUX-03 depth-3 fixture recorded | Prompt-regex registry (from P1-A A3) | P1-A, P1-C | ✓ landed wave 1 |
| P1-E | Session restore | asciicast recorder scaffold (`features/session-record/`) | Block/session persistence layers in IDB | Deterministic `VtEmulator.feed` (no wall-clock reads) | P1-C, P1-D | ✓ landed wave 1 (flag-off default) |
| P1-F | Output search scrollback | Per-block `features/output-search/` subtree exists | Scrollback `rowsInRange` API (P1-A A8) | Highlight overlay layer | P1-C | ✓ landed wave 1 |
| P1-G | Pager/REPL ghost hints | `features/autosuggest/` ghost-text styling reusable | Mode-stack emitter (P1-D) | Settings panel extensible | P1-D | ✓ landed wave 1 |
| P1-H | Perf live in CI | Perf harness scaffold (Agent-M) | `.github/workflows/perf.yml` (Agent-V) | `run-perf-budget.mjs` | — | ✓ landed wave 1 |
| P1-I | Sign-off automation | CI rule outputs machine-readable | Ship-gate definitions (README §12) | None | — | ✓ landed wave 1 |

**Parallel-ready on P0 green**: A, B, H, I — all delivered in wave 1.
**Sequential cascade**: A+B → C → {D, F} → {E, G} — all delivered in wave 1 (parallelised via spine-first strategy; the sequence constraints held within each epic's internal work items).

Open blockers for the P2 generation (see [p2-roadmap.md](./p2-roadmap.md)):
- P1 wave-2 polish + integration close-out (see "Wave 1 deltas vs p1-roadmap spec" above).
- P1 done-definition gates (p1-roadmap.md §"Done definition") independently verified — 12 gates mirror P0.
- P0 gate 7 perf green-at-budget verification remains the last residual P0-wave item, now re-tracked as a P1-H polish item (per-OS baseline + live PR-comment surface).

---

## Next steps (post P1 wave 1)

1. **P1 wave 2 polish + integration** — close the deltas in "Wave 1 deltas vs p1-roadmap spec" above. Highest priority: P1-C C10 (`block.outputChunks` field deletion) + strict-mode `no-block-chunks-in-render`; P1-A ADR 0021 + compat fixtures; P1-E privacy redaction + Safari private fallback.
2. **P1 done-definition verification** — run the 12 gates in p1-roadmap.md §"Done definition" against `868e482`; generate a P1 SHIP_SIGNOFF addendum via `tools/ship-signoff-gen/` (P1-I).
3. **Start P2 execution-surface work** — see [p2-roadmap.md](./p2-roadmap.md). Recommended order: P2-A Run entity seed lands in wave-2-D (tracked in p1-roadmap.md bonus track); full P2-A + P2-B gated on wave-3.
4. **Perf live-in-CI maturation (P1-H wave 2)** — land per-OS baselines (`tools/perf-baseline.json` + `tools/perf-baseline-macos.json`); wire PR comment bot (H6); green-at-budget verification for P0 gate 7 closes here.
5. **Compat fixture expansion** — `C-BD-01` / `C-BD-02` (boundary detector compat), `C-RESTORE-01` (session restore roundtrip), `C-SEARCH-01` (scrollback search big corpus). Tracked in p1-roadmap.md "Cross-cutting concerns".

---

## Risk signals

- If wave 2's `block.outputChunks` deletion (P1-C C10) surfaces remaining readers outside the flag-gated legacy surface, the strict-mode grep rule flip may need a second-pass migration under `shared/lib/text/project-output`.
- If P1-E's journal format version v1 is not forward-compatible with future Run-entity persistence (P2-A), wave 2 must emit a v2 schema before the flag flips default-on.
- If P1-H per-OS baselines diverge by more than the 20 % threshold, the PR-blocking comparator needs a platform-specific tolerance policy.
- If the hybrid detector's idle-tier (P1-A A4) fires during long-running commands that legitimately pause output (e.g. `read -t`, interactive `gcloud auth login`), escalate — R-A-2 mitigation may need dogfood tuning.
