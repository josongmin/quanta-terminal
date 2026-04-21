# Plan 0005 — Gap Tracking Matrix

- **Status**: Live (updated per epic landing) — wave-4 closed at `f74c047`; wave-5 in progress.
- **Cross-refs**: [README.md](./README.md) (§12 Success definition, §3 invariants), [test-strategy.md](./test-strategy.md) (§1 compat matrix, §9 ship checklist), [p1-roadmap.md](./p1-roadmap.md) (P1 epic specs + preconditions).

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

## P0 "ship with graceful behavior" gaps

| Gap | Epic | Sev | Status | Notes |
|-----|------|-----|--------|-------|
| G-SI-01 | δ/P1 | crit | deferred-P1 | Auto-install shell integration is a P1 enhancement (heuristic boundary first) |
| G-SI-02 | δ/P1 | crit | deferred-P1 | OSC 133 to boundary detector is a P1 item |
| G-SI-03..06 | P1 | — | deferred-P1 | All shell-integration enhancements are P1 |
| G-VT-03 | δ | high | landed (simplified) | P0 removes idle heuristic + fake exit; no block boundaries in P0 default |
| G-VT-04..06 | P1 | — | deferred-P1 | OSC 133 wiring, OSC 7 subscription, OSC 8 hyperlink (P1 when block chrome lands) |
| G-MS-01..06 | P1 | — | deferred-P1 | Mode Stack is P1 polish |

## P2 (execution surface) gaps

| Gap | Epic | Sev | Status | Notes |
|-----|------|-----|--------|-------|
| G-EX-01..09 | P2 | — | parked | Run entity work; unscheduled |
| G-IT-01..07 | P2 | — | parked | Intent layer; unscheduled |
| G-BP-01..06 | P2 | — | parked | Priority classes; P0 uses frame-skip + emergency drop |
| G-VT-08 | P2 | med | parked | DCS passthrough for plugin system |

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
| I-13 hybrid boundary | — | **deferred P1** (tracked in `p1-roadmap.md` as P1-A). |
| I-14 scrollback bounded | Scrollback ring in `VtEmulator` | ✓ **landed** (default 10,000 rows, pin hook `pinBlockedEvictions` / `_debugPinScrollbackRow` reserved for P1-A). |
| I-15..17 priority / intent / run | — | **deferred P2** (Run entity / Intent router / priority classes). |

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

## Wave 5 (polish + ship-signoff)

Parallel agents driving P0 final closure and documentation. Entries land here as each agent reports.

| Agent | Scope | Status |
|-------|-------|--------|
| AA | Docs finalization — test-strategy.md §1/§4.1/§5/§9; gap-tracking.md invariant + scorecard + wave-5 stub; fixture README stale-claim pass; README §12 gate verification | ⏳ in flight (this doc pass) |
| BB | Perf baselines — `docs/perf-baselines.md` augmentation for compat fixture rows; green-at-budget CI capture for gate #7 | ⏳ in flight |
| CC | Compat-harness final audit — `kind: recorded` + `sourceSessionId` promotion path; meta.json id/kind/version rollout over the 19 remaining wave 1-3 fixtures (advisory; non-blocking) | ⏳ in flight |
| DD | C-UX-02 resize fixture landing — leverages new `CheckpointExpected.resize` hook; flips wave-4 dedup comment to C-UX-04 only | ⏳ in flight |
| EE | P1 roadmap cleanup — cross-link verify, precondition table audit, epic numbering | ⏳ in flight |
| FF | P0 cleanup-report — typecheck/lint/test audit across `@quanta/host-common` + `@quanta/ui`; diagnose-and-report (no code mutations). Deliverable: `cleanup-report.md`. | ✓ delivered |

**P0 ship gate scorecard** (final state at `f74c047`; see README §12 "Success definition"):

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

**Count (final): 11/12 landed (✓); 1 partial (~ gate 7 perf green-at-budget).** Ship decision will be recorded in `SHIP_SIGNOFF.md` when a follow-up authoring agent delivers it (Agent-Z remit was not delivered in wave 4). Interim evidence for reviewers: Agent FF's `cleanup-report.md` (typecheck/lint/test-run audit at `f74c047`). Legend: ✓ landed + evidence; ~ partial (impl landed, verification pending); ⏳ not started.

Main thread drives remaining verification.

---

## P1 readiness

Precondition matrix for the 7 P1 epics (plus bonus H/I). Each precondition is either satisfied by a landed P0 artifact or carries a blocker ref. See [p1-roadmap.md](./p1-roadmap.md) for full spec.

| Epic | Title | Precondition 1 | Precondition 2 | Precondition 3 | Dependencies | Ready? |
|------|-------|----------------|----------------|----------------|--------------|--------|
| P1-A | Hybrid boundary detector | Scrollback pin hook (`pinBlockedEvictions`, `_debugPinScrollbackRow`) | OSC emitter on VtEmulator (parser-level present, needs promotion A7) | `boundary-detector.ts` port stable | — | ✓ ready |
| P1-B | Shell integration auto-install | Scripts shipped (`resources/shell-integration/{bash,zsh,fish}`) | `installShellIntegration` IPC wired | Wizard install.ts orchestration | — | ✓ ready |
| P1-C | Block overlay chrome | `flag.blockUx` store (default off) | `BlockCard` / `BlockList` widgets parked behind flag | Scrollback stable `rowId` on main buffer | P1-A (boundaries), P0 α3 | ⏳ needs A |
| P1-D | Mode stack polish | Alt-screen FSM (`features/tui/detect.ts`) | C-MUX-03 depth-3 fixture recorded | Prompt-regex registry (from P1-A A3) | P1-A, P1-C | ⏳ needs A+C |
| P1-E | Session restore | asciicast recorder scaffold (`features/session-record/`) | Block/session persistence layers in IDB | Deterministic `VtEmulator.feed` (no wall-clock reads) | P1-C, P1-D | ⏳ needs C+D |
| P1-F | Output search scrollback | Per-block `features/output-search/` subtree exists | Scrollback `rowsInRange` API (P1-A A8) | Highlight overlay layer | P1-C | ⏳ needs C |
| P1-G | Pager/REPL ghost hints | `features/autosuggest/` ghost-text styling reusable | Mode-stack emitter (P1-D) | Settings panel extensible | P1-D | ⏳ needs D |
| P1-H | Perf live in CI | Perf harness scaffold (Agent-M) | `.github/workflows/perf.yml` (Agent-V) | `run-perf-budget.mjs` | — | ✓ ready |
| P1-I | Sign-off automation | CI rule outputs machine-readable | Ship-gate definitions (README §12) | None | — | ✓ ready |

**Parallel-ready on P0 green**: A, B, H, I.
**Sequential cascade**: A+B → C → {D, F} → {E, G}.

Open blockers (not P1 epic-internal) — post-wave-4 state:
- P0 gate #2 `one-input-path` strict + 2 DEFER ✓ (Agent-L closed the TuiRenderSurface DSR path; `execute.ts` DEFER moves under P1-C's rule tightening).
- P0 gate #6 compat matrix ✓ 30/33 shipped; 1 WIP (C-UX-02, Agent DD in wave 5); 2 dedup'd. Baseline capture for P1-H can proceed.
- P0 gate #11 Rust flow-control ✓ merged (Agent-N). Perf baselines for `C-STRESS-*` unblock for capture via `docs/perf-baselines.md`.

---

## Next steps after agent completions

1. Review Agent-A worktree → merge into main (Epic α2 landed). Unblocks: session-level `VtEmulator` wiring (α1), scrollback ring (α3).
2. Review Agent-B worktree → merge into main (Epic γ1–γ6 landed). Unblocks: session ↔ batcher ↔ engine wiring in `features/session/connect.ts`.
3. Review Agent-C worktree → merge into main (compat harness live). C-ED-01 flips from `test.fails` to `test.ok` once α2 is merged.
4. Kick off next parallel batch:
   - Agent-D: Epic α1 (session-level VtEmulator wiring in `features/session/connect.ts`).
   - Agent-E: Epic α3 (scrollback ring inside VtEmulator).
   - Agent-F: Epic β draft (SessionInputSurface rename + mount in TerminalPage).
5. Compat fixture authoring: author C-MON-01 (top), C-PG-01 (less), C-UX-02 (resize) fixtures.
6. CI grep rules (`tools/check-one-render-path/`, `tools/check-one-input-path/`).
7. Epic δ (P0 default gating) — only after α + β + γ are stable.

---

## Risk signals

- If Agent-A's alt-buffer impl breaks an existing AnsiParser / GridMirror test outside VtEmulator, escalate: might need a deeper refactor of mode-event ordering.
- If Agent-B's frame-skip policy degrades perf on small writes (single-byte-enqueue case), revisit: may need a fast-path for queue < 1 KiB.
- If Agent-C's compat harness can't deterministically replay because of `VtEmulator` nondeterminism (e.g. timer-based behaviors), refactor the engine to accept an injected `clock()` source.
