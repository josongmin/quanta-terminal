# EPIC-I — xterm Removal + Legacy Surface Cleanup — Detailed Plan

- **Status**: Planning (Phase 6, **permission-gated**: does not fire until
  RFC 0001 §19 checklist is ALL-TRUE).
- **Date**: 2026-04-19
- **Scope owner**: EPIC-I planning agent.
- **Implements**: RFC 0001 v4 §13.12 (perf gate — must be green), §13.13 (budget
  decomposition — must be green), §13.14 (telemetry — must be healthy),
  §16 BAN #1/#2/#9/#10 (all cemented by removal), §17 Phase 6, §19 final
  removal gate (the hard precondition).
- **Freezes**: nothing new. This epic _retires_ the xterm fallback clause from
  ADR 0001 and removes the "two state models" architecture from the repo.
- **Out-of-scope**: any shift in renderer behavior, protocol, width table, or
  input encoding. Those land in EPIC-A through EPIC-H. This epic is a
  delete + docs + release-note operation.

This plan is the testable contract EPIC-I implementation will be held to. It is
also the **only epic in the plan set whose preflight is an external
permission check** rather than an upstream artifact. Nothing in this document
authorizes starting work; §3.2 of this plan is the gate.

---

## 1. Summary

**Goal**. Remove `@xterm/xterm` and its three addons (`addon-fit`,
`addon-web-links`, `addon-webgl`), delete `packages/ui/src/widgets/terminal-shell/`,
strip the `tuiActive` / `needsAltScreen` / `altScreenVisible` branching in
`TerminalPage.tsx`, update the four documentation surfaces that reference the
dual-engine architecture, and ship a release note. After this epic, the repo
holds exactly one VT engine (RFC §2 I-1) with no dead fallback path.

**Phase / Duration**. Phase 6 · 3 working days. Day 1 preflight + default-flip
verification, Day 2 source + dependency deletion + CI re-run, Day 3 docs +
release note + dogfood kickoff.

**Dependencies**. **RFC 0001 §19 gate ALL-TRUE**. This is not a "try to go
green"; it is the published, machine-captured checklist from EPIC-J's perf
harness (RFC §13.12) + EPIC-G's compat matrix (RFC §13.9) + EPIC-H's
side-by-side diff (RFC §13.11) + a signed 1-week internal dogfood log. If any
row is FALSE, this epic does not start. See §3.2.

**Owner**. EPIC-I implementation agent. Spec owner is the planning agent; the
implementation agent inherits this file as its spec and the §19 gate as its
kickoff contract.

**Why this epic exists separately**. The removal is small in lines-of-code
(delete ~1 directory, unstage ~4 deps) but enormous in consequence: once the
main branch no longer contains xterm, the rollback path is a point release,
not a feature flag. The discipline cost of making the cut formally, under a
fixed preflight, rather than "we think it's ready, let's delete," is the whole
value of this epic. The size of the doc is a function of the rigor needed
around that single commit, not the size of the diff.

---

## 2. Background & motivation

### 2.1 Why this epic is last

RFC §17 Phase 6 is deliberately the final phase. RFC §19 enumerates 13 preconditions
that together cover correctness (golden replay, side-by-side diff, CJK width,
IME), compatibility (vim, tmux, vim-in-tmux, ssh, alt-screen), performance
(baseline gate + per-stage budget), and telemetry health (no unknown-CSI
storms, snapshot frequency trending to zero, no epoch-drift storm), plus a
hard 1-week dogfood window. RFC §2 I-10 makes "xterm is removed ONLY after
§19 is ALL-TRUE" a non-negotiable invariant.

Why so strict? RFC §4.3 lays out the problem: every xterm.js release has
historically shipped a CJK / IME / WebGL regression that cost us engineering
days. That risk is the whole reason we built the custom engine. The goal of
this epic is therefore not just to delete files — it is to _cement the
architecture win_ by making the dual-engine state model structurally
impossible to reintroduce.

### 2.2 What "two state models" actually meant

Phase 2 had:

- A React-rendered block list driven by reducer output.
- `xterm.js` holding a full grid + scrollback + DEC modes + OSC + charset +
  cursor, living inside `packages/ui/src/widgets/terminal-shell/TerminalShell.tsx`,
  gated on `tuiActive` / `needsAltScreen` / `altScreenVisible` flags pushed
  from the reducer.

Selection, copy, search, width, IME, mouse reporting — every one of those
features had to answer "which engine owns this right now" _at runtime_, and
then fan out to different code paths. RFC §4.1 called this "the structural
cost of two independent state models." This epic is where that cost is paid
off for good: after this commit, the question goes away.

### 2.3 RFC invariants this realizes

- **I-1 — Exactly one VT engine.** Trivially true before this epic (the canvas
  path already routes PTY bytes through `quanta-vt`) but _demonstrably_ true
  after: `grep -ri "xterm" packages/` returns zero non-historical hits.
- **I-10 — xterm removed only after §19 is ALL-TRUE.** This epic's preflight
  IS that gate. See §3.2.
- **§16 BAN #1 (UI re-parses ANSI).** Cemented: without xterm, there is no
  TS ANSI parser in the repo, period. EPIC-K's `check-ui-no-ansi` grep rule
  (see `epic-K-ci-platform-golden-infra.md`) continues to enforce going
  forward.
- **§16 BAN #2 (Block owns the output buffer).** Cemented: with xterm gone,
  `BlockList` can only consume `GridMirror` output from EPIC-C.

### 2.4 What this epic is _not_

It is NOT a performance epic. EPIC-J owns that.
It is NOT a compat epic. EPIC-G owns that.
It is NOT a side-by-side epic. EPIC-H owns the side-by-side harness and it
stays alive as a dev-only tool even after xterm ships. (In fact, that harness
is retained in the repo with the xterm side replaced by a "memory backend"
reference renderer under EPIC-D §3 — see EPIC-H for the details.)

---

## 3. Scope

### 3.1 In-scope files

#### 3.1.1 Files DELETED

- `packages/ui/src/widgets/terminal-shell/TerminalShell.tsx`
- `packages/ui/src/widgets/terminal-shell/useTerminalSurface.ts`
- `packages/ui/src/widgets/terminal-shell/alt-screen-stream.ts`
- `packages/ui/src/widgets/terminal-shell/terminal-shell.module.css`
- `packages/ui/src/widgets/terminal-shell/index.ts`
- `packages/ui/src/widgets/terminal-shell/__tests__/` (entire directory)
- `packages/ui/src/widgets/terminal-shell/` (parent directory removed once
  empty; this implies `rm -rf`, but the preceding file-level enumeration is
  the checklist the reviewer diffs against).

Audit candidates — delete IF AND ONLY IF unreferenced after the above:

- `packages/ui/src/shared/config/theme.ts` — if its only non-trivial import is
  `ITheme` from `@xterm/xterm`, either inline the type (`interface Theme {
  background: string; foreground: string; ... }`) or delete the file entirely
  when every consumer now uses the canvas renderer's theme types. The audit
  step in §5.1 covers this.
- Any `useTerminalSurface` re-exports elsewhere in the tree. Grep confirms.

#### 3.1.2 Files MODIFIED

- `packages/ui/package.json` — remove the four `@xterm/*` entries from
  `dependencies`:
  - `@xterm/xterm`
  - `@xterm/addon-fit`
  - `@xterm/addon-web-links`
  - `@xterm/addon-webgl`
- `packages/ui/src/pages/terminal-page/TerminalPage.tsx` — remove all of:
  - `tuiActive` selector + prop drilling
  - `needsAltScreen` branching
  - `altScreenVisible` branching
  - any `<TerminalShell>` JSX mount (the entire conditional is replaced by
    an unconditional `<TerminalCanvas>` mount; mode transitions are
    expressed as chrome-collapse states driven by `ModeChanged` events per
    EPIC-H §3).
- `packages/ui/src/entities/tui/model.ts` — either:
  - **Simplify** to a pure view-selector over `ModeChanged`-driven store
    state (keep the module alive as the reducer-→-chrome-state bridge), OR
  - **Delete** if all consumers have moved to reading mode state directly
    from the `GridMirror` subscription. The audit step in §5.1 decides.
- `packages/ui/src/entities/tui/index.ts` — follows the above decision.
- `packages/ui/src/entities/tui/__tests__/` — update-or-delete per the
  above.
- `docs/adr/0001-host-modes.md` — remove the xterm fallback clause; update
  the Status block to reflect the unified engine; cross-link to this epic
  and to RFC 0001.
- `docs/terminal-benchmark-matrix.md` — add a "canvas-renderer" column; mark
  the xterm column as "historical — removed in v1.0 per RFC 0001 §19 gate";
  keep the historical numbers for context.
- `docs/RELEASE.md` — add a release note section: "xterm.js removed — canvas
  renderer is now the sole engine" with migration guidance for anyone who
  had shipped a fork with `data-renderer="xterm"` and the point-release
  rollback escape hatch.
- `docs/technical-architecture.md` — update any diagram / paragraph that
  shows the dual-engine split to reflect the unified engine. Cross-link to
  RFC 0001 §7.

#### 3.1.3 Files LEFT ALONE (explicit non-scope)

- `packages/ui/src/widgets/terminal-canvas/` — the canvas renderer is the
  replacement; do not touch.
- `packages/ui/src/shared/ui/cell-renderer/` — the cell-renderer infra; do
  not touch.
- `packages/ui/src/features/compat/SideBySideHarness.tsx` — retained as a
  dev-only tool with the xterm side replaced by `MemoryBackend` per
  EPIC-H §3. **Do not delete.** EPIC-H owns the swap; this epic only
  verifies that no `@xterm/*` import lingers there.
- `crates/quanta-vt-width/`, `crates/quanta-metrics/` — out of scope per the
  parent parallel-agent brief.
- All other `docs/adr/*.md` not enumerated — out of scope unless they
  contain a hard xterm reference. See §5.1 audit.

### 3.2 Preflight — §19 gate is the kickoff contract

This epic **does not start** until every row below carries a machine-captured
or artifact-backed TRUE.

| § | Row | Evidence source |
|---|---|---|
| §19.1 | Golden replay 100% pass | `crates/quanta-vt/tests/compat/` CI job green (EPIC-G + EPIC-K `vt-engine.yml`) |
| §19.2 | xterm vs canvas diff = 0 across matrix | `packages/ui/src/features/compat/side-by-side-report.json` attached to release PR |
| §19.3 | IME real-usage clean (Korean, Japanese, Chinese) | EPIC-E IME recording CI green + signed dogfood log |
| §19.4 | CJK + emoji width correct (ZWJ, VS16) | EPIC-A parity test green |
| §19.5 | `vim` OK | EPIC-G `compat/vim/` green |
| §19.6 | `tmux` OK | EPIC-G `compat/tmux/` green |
| §19.7 | `vim` inside `tmux` OK | EPIC-G `compat/vim-in-tmux/` green |
| §19.8 | `ssh` remote OK | EPIC-G `compat/ssh-loopback/` green |
| §19.9 | Alt-screen enter/exit/nested OK | EPIC-H `alt-screen` tests green |
| §19.10 | Resize during alt-screen OK | EPIC-B resize-stress test + EPIC-H transition test |
| §19.11 | Perf gate green | EPIC-J `perf.yml` green on baseline hardware |
| §19.12 | Perf budget decomposition green per-stage | EPIC-J stage histograms within RFC §13.13 p95 targets |
| §19.13 | Telemetry healthy (no unknown-CSI storm, full-redraw trending to zero, no epoch-drift storm) | EPIC-J dogfood dashboard screenshot + metric dump |
| — | ≥ 1 week internal dogfood clean | Dogfood log committed to `docs/dogfood-logs/<date>.md` (retained for audit) |

All 13 + 1 rows must be TRUE **simultaneously**. The planning agent does not
authorize the implementation agent to start until this gate is signed off by
a human reviewer; the sign-off goes in the preflight-gate issue that the
implementation agent opens on Day 0. If any row flips to FALSE mid-epic
(e.g., a dogfood regression on Day 2), the implementation agent halts,
reverts any in-progress commits, and escalates.

### 3.3 Out-of-scope files

- `crates/quanta-vt-width/*` — EPIC-A surface, no-touch per the parallel-agent
  brief.
- `crates/quanta-metrics/*` — EPIC-J surface, no-touch per the parallel-agent
  brief.
- `.github/workflows/*.yml` — EPIC-K surface.
- Any test fixture under `__tests__/fixtures/` that contains the literal
  string `xterm` for historical reasons — see §5.2 allowlist.

---

## 4. Design

### 4.1 Execution model

Three phases, one per working day, with an explicit gate between each:

```
Day 0  preflight: open §19 gate issue, attach artifacts, get sign-off ┐
                                                                      │
Day 1  flip default to canvas + full CI green ────────────────────────┤
                                                                      │
Day 2  delete xterm source + deps + full CI green ────────────────────┤
                                                                      │
Day 3  docs + release note + dogfood kickoff ─────────────────────────┘
```

The Day-1 "flip to canvas default as a separate commit from the deletion" is
deliberate: if an unexpected CI regression fires purely from switching the
default flag, we catch it in a commit whose revert restores xterm-as-default
without needing to restore xterm-as-file. This is the safety belt of a
2-step removal.

### 4.2 Removal sequence

1. **Day 1 step 1.** Land a commit that changes the default value of the
   `data-renderer` flag from `"xterm"` (or whichever the tracking value
   was in EPIC-H §3) to `"canvas"`. `data-renderer="xterm"` still works at
   this commit — xterm source is alive, just not default.
2. **Day 1 step 2.** Re-run the full matrix: `pnpm -r test`,
   `cargo test --workspace`, `pnpm typecheck`, all workflow sub-jobs per
   EPIC-K `vt-engine.yml` / `ui-renderer.yml` / `parity.yml` /
   `compat-matrix.yml`. All green → proceed. Any red → revert commit,
   re-diagnose, re-run §19 gate evidence.
3. **Day 2 step 1.** Land a commit that:
   - Deletes every file in §3.1.1.
   - Removes the four `@xterm/*` entries from `packages/ui/package.json`.
   - Strips the `tuiActive` / `needsAltScreen` / `altScreenVisible`
     branching from `TerminalPage.tsx`.
   - Runs `pnpm install --frozen-lockfile` to regenerate the lockfile
     without xterm entries.
4. **Day 2 step 2.** Re-run the full matrix. All green → proceed. Any red →
   diagnose. Do NOT amend the commit; if a fix is needed, land it as a
   follow-up commit on the same PR to preserve audit history.
5. **Day 3 step 1.** Land the docs commit: ADR 0001 update,
   `terminal-benchmark-matrix.md` column flip, `technical-architecture.md`
   diagram update, `RELEASE.md` release note.
6. **Day 3 step 2.** Kick off the 1-week post-removal dogfood: open a
   tracking issue, attach daily screenshots / metric dumps to it. Dogfood
   runs on macOS arm64 + Linux x86_64. Windows is "known partial" per
   RFC §14.5 + EPIC-K `platform-matrix.md`.

### 4.3 Post-removal grep

```bash
grep -rni "xterm" packages/ --exclude-dir=node_modules --exclude-dir=dist
```

Allowed hits:

1. A comment on the form `// historical-xterm-reference: <reason ≥ 10 chars>`
   — the pragma mirrors EPIC-K's allowlist convention and MUST carry a human
   reason, not a bare pragma.
2. Any hit inside a compat fixture file (path matches
   `__tests__/fixtures/` or `crates/quanta-vt/tests/compat/`) where the
   fixture is a recorded PTY byte stream. Those files may contain the
   literal word `xterm` as part of a `$TERM` query response and are
   historical by nature.

Any other hit → removal is incomplete; land a follow-up commit before
closing the epic.

### 4.4 TerminalPage simplification contract

`TerminalPage.tsx` after this epic satisfies:

- Renders exactly one `<TerminalCanvas>` mount.
- Consumes `ModeChanged` events (via `GridMirror` subscription) to drive
  chrome-collapse states under EPIC-H's contract. No `tuiActive` /
  `needsAltScreen` / `altScreenVisible` local state; no legacy selector.
- The file's line count should drop by ~40% (empirical estimate — actual
  depends on the pre-epic state after EPIC-H).
- All existing page-level tests continue to pass without modification. Any
  test that _asserts the xterm mount_ is a test of removed behavior and is
  deleted alongside the source it tests; the test-deletion is part of the
  Day-2 commit, not a separate step.

### 4.5 `entities/tui/` decision tree

```
Is `entities/tui/` referenced by anything after TerminalPage is simplified?
├─ No  → delete the directory entirely.
└─ Yes → is the reference a pure view-selector over ModeChanged-driven store state?
          ├─ Yes → keep; update imports to the canvas store; tests updated.
          └─ No  → refactor to be, then re-enter the tree.
```

The audit grep (§5.1) is the input. The implementation agent decides at that
moment; the planning-doc review does not prescribe which branch fires.

### 4.6 Bundle-size verification

Before the Day-2 commit: record bundle size via `pnpm --filter ui build` →
`dist/` size.
After the Day-2 commit: record the same.
Expected delta: xterm + its three addons are roughly 500 KB minified +
gzipped. Record the actual delta in the PR description. If the delta is
< 100 KB, something is wrong (xterm got tree-shaken unexpectedly, or some
consumer is still pulling it transitively); diagnose before landing.

### 4.7 ADR 0001 change set

Before:

> Status: Accepted (Phase 2). Canvas renderer is the primary path; xterm is
> retained as a fallback for alt-screen programs where the canvas path has
> known gaps.

After:

> Status: Superseded-by-itself (Phase 6). Canvas renderer is the sole path.
> Historical fallback clause is retired per RFC 0001 §19 gate all-true on
> <date> and EPIC-I merge commit <sha>. See `docs/RELEASE.md` for the
> removal release note.

The exact wording is drafted at Day-3 commit time with the actual date / SHA
filled in.

### 4.8 `terminal-benchmark-matrix.md` change set

The benchmark matrix keeps every historical row so year-over-year comparisons
remain possible. After this epic the rightmost "current engine" column is
labelled `canvas-renderer (v1.0+)` and the xterm column is labelled `xterm.js
(v5.5, removed v1.0)`. The numbers already present do not change.

### 4.9 Release note contract

The entry in `docs/RELEASE.md` covers:

1. **What changed.** xterm.js and its three addons are removed. The canvas
   renderer is the sole terminal engine.
2. **Why.** One-line summary pointing to RFC 0001 §4.1 and §4.3.
3. **User-visible impact.** "None expected" — the §19 gate includes a
   side-by-side zero-diff across the compat matrix, so the visible behavior
   is identical.
4. **Forks.** Anyone maintaining a fork with `data-renderer="xterm"` must
   migrate or pin to the pre-removal tag.
5. **Rollback.** Point-release only. We will not ship a feature flag to
   re-enable xterm; the commit history contains the restore path if an
   emergency demands it.
6. **Related RFCs / ADRs.** RFC 0001, ADR 0001 (now updated).

---

## 5. Definition of Done (DoD)

Every item is a test file, a grep command, a CI job, or an artifact. No
"reviewed" / "looks good" items. This is a concrete checklist.

### 5.1 Preflight + audit (Day 0)

- [ ] **I-DoD-01.** §19 gate sign-off issue exists, references the 13 rows +
  dogfood log, and carries a human approver. Issue URL pasted in the
  implementation PR description.
- [ ] **I-DoD-02.** `docs/perf-baselines.md` has a baseline number per-stage
  (RFC §13.13) for macOS arm64 + Linux x86_64 and `perf.yml` is green.
- [ ] **I-DoD-03.** `side-by-side-report.json` attached to the preflight
  issue shows zero cell / cursor / mode / input-byte diffs across the
  full compat matrix.
- [ ] **I-DoD-04.** Dogfood log file exists at `docs/dogfood-logs/<date>.md`
  with ≥ 7 daily entries, each carrying hours of use + incident count.
- [ ] **I-DoD-05.** Audit grep run: `grep -rln "@xterm/" packages/ crates/ tools/`
  captured in the preflight issue as the baseline import set. Expected
  output is exactly the files in §3.1.2 plus `packages/ui/package.json`.

### 5.2 Default flip (Day 1)

- [ ] **I-DoD-06.** Commit A lands: default `data-renderer="canvas"` across
  `TerminalPage.tsx` + any dev-flag source. `data-renderer="xterm"` still
  compiles and can be forced for regression-bisect.
- [ ] **I-DoD-07.** `pnpm -r test` green on commit A.
- [ ] **I-DoD-08.** `cargo test --workspace` green on commit A.
- [ ] **I-DoD-09.** `pnpm typecheck` (all packages) green on commit A.
- [ ] **I-DoD-10.** `.github/workflows/ci.yml` + `vt-engine.yml` +
  `ui-renderer.yml` + `parity.yml` + `compat-matrix.yml` all green on
  commit A.

### 5.3 Source + dependency deletion (Day 2)

- [ ] **I-DoD-11.** Commit B lands: every file in §3.1.1 deleted; every
  `@xterm/*` entry in `packages/ui/package.json` removed.
- [ ] **I-DoD-12.** `pnpm install --frozen-lockfile` regenerates lockfile;
  diff shows zero `@xterm/*` entries.
- [ ] **I-DoD-13.** `find packages/ -type d -name terminal-shell` returns
  empty.
- [ ] **I-DoD-14.** `grep -rni "xterm" packages/ --exclude-dir=node_modules`
  returns only historical-marker comments or fixture files (§4.3
  allowlist).
- [ ] **I-DoD-15.** `TerminalPage.tsx` has no `tuiActive` / `needsAltScreen`
  / `altScreenVisible` occurrences (grep-verified).
- [ ] **I-DoD-16.** `packages/ui/src/entities/tui/` either deleted entirely
  OR reduced to a `ModeChanged`-driven view-selector per §4.5. Either
  outcome is DoD-satisfying; both are documented in the PR description.
- [ ] **I-DoD-17.** `pnpm -r test` green on commit B. No skipped tests.
  Test count after ≥ test count before minus the deleted `terminal-shell/
  __tests__/` entries (which are expected to go).
- [ ] **I-DoD-18.** `cargo test --workspace` green on commit B.
- [ ] **I-DoD-19.** `pnpm typecheck` green on commit B.
- [ ] **I-DoD-20.** FSD-layer check (`pnpm --filter ui lint:fsd`) clean.
- [ ] **I-DoD-21.** `tools/check-hex-imports/` run clean.
- [ ] **I-DoD-22.** `tools/check-ui-no-ansi/` run clean (EPIC-K surface;
  expected to already be passing, but re-verify post-delete).
- [ ] **I-DoD-23.** `packages/ui` bundle size measured pre- and
  post-commit; delta ≥ 100 KB minified+gzipped; delta number pasted in PR.
- [ ] **I-DoD-24.** Side-by-side harness
  (`packages/ui/src/features/compat/SideBySideHarness.tsx`) still compiles
  with `MemoryBackend` on the second side per EPIC-H §3; its tests are
  green. This is the `BackendContract` proof that renderer-agnosticism
  survives removal.

### 5.4 Documentation + release (Day 3)

- [ ] **I-DoD-25.** Commit C lands: ADR 0001 updated per §4.7; diff shows
  the removed fallback clause and the updated status.
- [ ] **I-DoD-26.** `docs/terminal-benchmark-matrix.md` updated per §4.8
  (column renamed, historical column preserved).
- [ ] **I-DoD-27.** `docs/technical-architecture.md` diagrams show the
  unified engine (no "dual renderer" box); at least one diagram changed.
- [ ] **I-DoD-28.** `docs/RELEASE.md` has a release-note entry covering the
  six points in §4.9.
- [ ] **I-DoD-29.** Cross-links in the release note + ADR point back to
  RFC 0001 + this epic + the merge SHA.
- [ ] **I-DoD-30.** Post-removal dogfood tracking issue opened with a
  1-week review date set.

### 5.5 Post-merge verification (week 4 of epic cadence)

- [ ] **I-DoD-31.** 7 consecutive days of dogfood logged; zero xterm-
  related issues reported (because there is no xterm).
- [ ] **I-DoD-32.** `pnpm audit` shows no stranded xterm vulnerabilities
  against the retired version (a proxy check for lockfile cleanliness).
- [ ] **I-DoD-33.** RFC 0001 status flipped to Accepted (was Proposed) —
  this is the RFC's own acceptance gate, and this epic is the last
  barrier. The change is a separate PR by the RFC author; this DoD item
  is a pointer, not a task for this epic's implementation agent.

---

## 6. Quality gates

| Gate | Check | Run when | Fail response |
|---|---|---|---|
| §19 preflight | All 13 rows + 1 dogfood row TRUE, signed | Day 0 | Halt epic; escalate |
| CI: `pnpm -r test` | zero failures, zero skipped-unexpectedly | Every commit | Revert, diagnose, re-land |
| CI: `cargo test --workspace` | zero failures | Every commit | Revert, diagnose, re-land |
| CI: `pnpm typecheck` | zero TS errors | Every commit | Revert, diagnose, re-land |
| CI: `vt-engine.yml` | green | Every commit | Revert (canvas engine regressed), diagnose |
| CI: `ui-renderer.yml` | green | Every commit | Revert, diagnose |
| CI: `compat-matrix.yml` | green (macOS arm64 + Linux x86_64 MUST; Windows may be known-partial) | Every commit | See EPIC-K §4.5 partial policy |
| CI: `parity.yml` | green | Every commit | Revert |
| Grep: `"xterm"` hits | zero non-historical, non-fixture hits | Day 2 + CI post-merge | Land follow-up removal commit |
| Grep: `"tuiActive"` | zero in `packages/ui/src/` | Day 2 | Land fix |
| Grep: `"needsAltScreen"` | zero in `packages/ui/src/` | Day 2 | Land fix |
| Grep: `"altScreenVisible"` | zero in `packages/ui/src/` | Day 2 | Land fix |
| Grep: `@xterm/` | zero in any `package.json` across the workspace | Day 2 | Land fix |
| Bundle size | ≥ 100 KB (minified+gzipped) reduction | Day 2 | Diagnose tree-shake; do not merge until resolved |
| Dogfood week | zero xterm-flagged incidents | Day 3 → Day 10 | Do NOT revert automatically; open P1 investigation (since there IS no xterm, the report is either a misattribution or a canvas bug) |

---

## 7. E2E scenarios

Each scenario is an exact keystroke + observable sequence the implementation
agent (and CI) runs against the post-removal build. Minimum 6.

### 7.1 E2E-I1 — `vim` in a fresh session

**Goal**. Confirm `vim` is pixel-identical to pre-removal on the canvas
path.

**Steps**.
1. Launch Quanta, open a new session.
2. Run `vim /tmp/hello.txt`.
3. Press `i`, type `Hello world`, press `Esc`, type `:wq`, press `Enter`.
4. Re-open: `cat /tmp/hello.txt` prints `Hello world`.
5. Capture a canvas-renderer screenshot via the devtools hook; diff against
   the golden snapshot committed in EPIC-H. Expect zero pixel diff.

**Pass**. Steps 3 and 4 work; pixel diff zero. No xterm mount appears in the
DOM (inspect: `document.querySelectorAll("[data-renderer]")` returns
`canvas` only).

### 7.2 E2E-I2 — `tmux` pane split

**Goal**. Confirm tmux mode-negotiation and alt-screen chrome are not
regressed.

**Steps**.
1. Launch Quanta, open a new session.
2. Run `tmux new-session`.
3. Press `Ctrl+b %` to split vertically.
4. In right pane: `htop`.
5. In left pane: `ls -la`, `cd /tmp`, `ls`.
6. Press `Ctrl+b x` in the right pane; confirm exit prompt; `y`.
7. Press `Ctrl+b d` to detach.

**Pass**. Panes render without column tearing. htop refreshes at 1 Hz.
Chrome collapses correctly when tmux enters alt-screen; re-expands on
detach. Side-by-side harness (if re-enabled for this run) shows zero
divergence vs the pre-removal golden capture.

### 7.3 E2E-I3 — ssh to localhost

**Goal**. Confirm the compat matrix's ssh-loopback entry remains green
without xterm.

**Steps**.
1. Ensure `sshd` is running locally.
2. `ssh $USER@127.0.0.1` (with key auth; no password prompt expected).
3. In the ssh session: `vim /tmp/ssh-test.txt`, insert `ssh test`, save,
   exit.
4. `exit` from ssh.

**Pass**. vim renders identically under ssh. No width drift (try typing a
Korean string in insert mode: `한글테스트`). `TERM` inside the ssh session
is `xterm-256color` per RFC §14.6 — this is the identity string, not a
runtime dependency.

### 7.4 E2E-I4 — Korean 2-set IME compose + commit

**Goal**. The single most load-bearing IME scenario survives removal.

**Steps**.
1. Set macOS input source to "Korean — 2-Set Korean".
2. Open a new Quanta session; type at a bash prompt.
3. Type `r`, `k`, space → observe preedit overlay shows `가`, then commits.
4. Type `vim /tmp/kr.txt`, press `i`, type `gksrlf` with the 2-set IME →
   should commit as `한글`.
5. Press `Esc`, `:wq`, `Enter`.
6. `cat /tmp/kr.txt` prints `한글`.

**Pass**. Preedit overlay renders above cell grid (EPIC-E §6 contract). No
partial bytes emitted to PTY during composition (inspect via
`ime.lifecycle_update` counter — it increments; `ime.abnormal_termination`
stays zero). Final file contains exactly `한글\n`.

### 7.5 E2E-I5 — Alt-screen enter/exit chrome collapse/expand

**Goal**. EPIC-H's chrome transition survives removal — specifically, that
the `ModeChanged`-driven path does not regress when the xterm branch is
gone from `TerminalPage.tsx`.

**Steps**.
1. Open a Quanta session.
2. Run `less /etc/hosts`.
3. Observe: block chrome collapses to a thin status line within 160 ms
   (EPIC-H §acceptance).
4. Press `q` to exit less.
5. Observe: chrome re-expands within 160 ms.
6. Repeat for `vim`, `htop`, `tmux attach`.

**Pass**. Collapse / re-expand animation runs each time. No frame where the
chrome and the alt-screen content overlap visually (EPIC-H §acceptance's
"`ModeChanged` arrives before first alt-buffer cell delta" invariant is
what prevents it; this E2E confirms behavior end-to-end).

### 7.6 E2E-I6 — Bundle size pre vs post

**Goal**. Machine-verify the claimed bundle reduction.

**Steps**.
1. `git checkout <pre-epic-I-sha>`.
2. `pnpm --filter ui build`; record `dist/` total size.
3. `git checkout <post-epic-I-sha>`.
4. `pnpm --filter ui build`; record `dist/` total size.
5. Compute delta; confirm ≥ 100 KB minified + gzipped, with a soft target
   of ~500 KB matching xterm + addons' on-disk footprint.

**Pass**. Delta meets the gate; xterm chunk absent from the
`dist/assets/*.js` manifest.

### 7.7 E2E-I7 — `grep -ri "xterm" packages/` returns only allowed hits

**Goal**. The non-negotiable invariant's observable signal.

**Steps**.
1. `grep -rni "xterm" packages/ --exclude-dir=node_modules --exclude-dir=dist`
2. Confirm every hit falls into one of:
   - `// historical-xterm-reference: <reason ≥10 chars>` comment
   - a fixture file under `__tests__/fixtures/`

**Pass**. No other hits. This is also DoD-14; this E2E is its CLI drill.

### 7.8 E2E-I8 — Point-release rollback drill (disaster scenario)

**Goal**. Verify the rollback path physically works, even though we commit
to not using it.

**Steps**. (Run in a detached branch; DO NOT merge.)
1. `git revert <commit-B-sha>`.
2. `pnpm install`.
3. `pnpm -r test`.
4. Run E2E-I1 to confirm the pre-removal build is behaviorally intact.

**Pass**. The revert builds and passes its own tests. Branch is deleted
after the drill; the drill itself is documented in the rollback section
below.

---

## 8. Test deliverables

### 8.1 Artifacts produced by this epic

- **Preflight gate issue** (GitHub issue) with §19 checklist + dogfood log +
  perf baseline attached. Archived by the tracker's normal retention.
- **PR description** with:
  - Commit A summary (default flip).
  - Commit B summary (delete + deps).
  - Commit C summary (docs + release).
  - Bundle-size delta (pre / post / delta in bytes).
  - Grep output proving zero non-historical xterm hits.
  - Link to the preflight gate issue.
- **Dogfood tracking issue** with 7 daily entries over Days 3-10.
- **Release note** in `docs/RELEASE.md`.

### 8.2 Artifacts NOT produced by this epic

- **New tests.** This epic deletes tests (the `terminal-shell/__tests__/`
  set) and updates tests that asserted dual-mount behavior. It does not
  add new tests; EPIC-H and EPIC-G own the post-removal canvas coverage.
- **New docs beyond the four updated files.** Deliberately scoped. Any
  architecture doc that references xterm belongs to the ADR or the RFC,
  not to a new doc.

### 8.3 Artifact retention

The `side-by-side-report.json` attached to the preflight issue is archived
for audit; it is the formal record that §19.2 was TRUE at removal. Dogfood
logs under `docs/dogfood-logs/` stay in the repo indefinitely — they are a
small, append-only record of the migration.

---

## 9. Failure modes retired

This epic retires a different class of failure than EPIC-A through EPIC-H.
Those epics retire specific bug classes (width drift, IME double-input,
resize races). This epic retires a **meta-risk**:

- **RFC §2.3 dependency risk.** xterm.js shipping a regression we cannot
  patch. Post-removal the risk is zero: there is no dependency to ship a
  regression.
- **RFC §4.1 two-state-models risk.** The architectural ambiguity over
  which engine owns a given cell. Post-removal the question is
  ill-formed.
- **RFC §16 BAN #1.** UI re-parses ANSI. EPIC-K's `check-ui-no-ansi`
  enforces forward; this epic removes the one place in the repo that ever
  could have.
- **RFC §16 BAN #2.** Block owns the output buffer. Without xterm's grid,
  the temptation to put authoritative state in the block layer is
  structurally foreclosed.

No row of RFC §22's 20 concrete failure modes is owned by this epic —
those are all owned by EPIC-A through EPIC-H. This epic is the _cement_
rather than the _mortar_.

---

## 10. Risks

### 10.1 False-positive grep hit on `"xterm"` in a benign context

**Likelihood**. Low.
**Impact**. Medium — could block Day-2 merge.
**Mitigation**. §4.3 allowlist: `// historical-xterm-reference: <reason>`
pragma + fixture-file path allowance. EPIC-K's grep rule predates this
epic and has the same convention; consistency is the mitigation.
**Detection**. Day-2 CI surfaces the hit; implementation agent adds the
pragma or reverts the reference.

### 10.2 User with xterm-ed mental model misses the UX change

**Likelihood**. Medium.
**Impact**. Low — the §19 gate guarantees no visible behavior change, so
mental-model surprise is theoretical.
**Mitigation**. Release-note entry (§4.9) is explicit: "no user-visible
change; if you see one, file a P1."

### 10.3 Post-removal regression discovered in dogfood

**Likelihood**. Low (gated by 1-week pre-dogfood + 1-week post-dogfood
runs).
**Impact**. High — would require point release.
**Mitigation**. Point-release rollback path (§11). Feature-flag rollback
is NOT offered; we do not re-introduce the dual-state architecture.

### 10.4 Side-by-side harness breaks silently at delete time

**Likelihood**. Low.
**Impact**. Medium — loses a useful dev tool.
**Mitigation**. DoD-24 exercises the harness post-delete with
`MemoryBackend` per EPIC-H §3. If EPIC-H did not land that replacement
first, this epic blocks on EPIC-H completion.

### 10.5 `pnpm install` lockfile churn unrelated to xterm

**Likelihood**. Medium (transitive dep hoist changes on removal).
**Impact**. Low — review and accept if benign.
**Mitigation**. Run `pnpm install --frozen-lockfile` first to see the
required lockfile delta; land the lockfile change in Commit B; include
the diff in the PR description.

### 10.6 Bundle size does not decrease as expected

**Likelihood**. Low.
**Impact**. Medium — suggests xterm was tree-shaken already (benign) or
there is a lingering import (bad).
**Mitigation**. DoD-23 requires the measurement; a < 100 KB delta halts
the merge pending diagnosis.

---

## 11. Rollback

### 11.1 Pre-merge rollback (Days 1-3, before the PR lands)

Standard git revert of the in-progress commits. No consequence beyond a
delayed epic.

### 11.2 Post-merge, pre-release rollback (commit in main but not tagged)

`git revert <commit-B-sha> <commit-A-sha>` — the two functional commits
are reverted; the docs commit can stay or go depending on narrative
preference. CI re-runs to confirm; the release is delayed.

### 11.3 Post-release rollback (tagged version ships)

This is the scenario §4.9 calls out. The canvas renderer already ships as
the default by the time the tag cuts; the revert is cosmetic (restores
xterm code as _previously seen_, not _currently used_). Path:

1. Open a release-blocker issue.
2. Cut a point release (v1.0.1) with the commits reverted.
3. Release note explicitly records the rollback + root cause.
4. Re-plan EPIC-I fire after the root-cause fix lands + a new §19 gate
   run.

We do NOT ship a runtime feature flag. The lesson of RFC §4.1 is that
dual-state architectures are a bug farm; re-introducing one as a
rollback valve would undo the whole project's reason to exist. A point
release is the escape hatch, and its friction is the deterrent we want.

### 11.4 What cannot be rolled back

The ADR 0001 update (§4.7). Once that document reflects the unified
engine, any subsequent rollback updates the ADR _forward_, not back.
This is deliberate: the ADR is the document of record for what the
system is today, and a rollback makes the system something different,
which is a new ADR revision, not a revert.

---

## 12. Cross-references

### 12.1 Upstream (what must be TRUE before this epic starts)

- **RFC 0001 §19** — the gate.
- **EPIC-A** — width parity green.
- **EPIC-B** — engine core shipped + golden replay green.
- **EPIC-C** — protocol + mirror landed.
- **EPIC-D** — canvas renderer + selection landed.
- **EPIC-E** — input encoder + IME landed.
- **EPIC-F** — actor integration shipped.
- **EPIC-G** — compat matrix green.
- **EPIC-H** — side-by-side harness green; `MemoryBackend` replacement
  landed in side-by-side code path.
- **EPIC-J** — perf baseline + telemetry healthy.
- **EPIC-K** — CI grep rules + workflows green.

### 12.2 Downstream (what becomes possible after this epic)

- **RFC 0001 status Accepted** (RFC author's separate action).
- **RFC 0002 (WebGL renderer)** can start; the backend contract (RFC §12)
  is the only boundary a new backend needs to satisfy, and after removal
  the contract is the ground truth rather than one of two options.
- **RFC 0003 (graphics protocols)** unblocked similarly.

### 12.3 Related ADRs

- **ADR 0001 (host modes)** — updated here.
- **ADR 0015 (width / grapheme / line-break SSOT)** — EPIC-A surface.
- **ADR 0016 (selection / search / copy semantics)** — EPIC-D surface.
- **ADR 0017 (reducer ordering + mode authority)** — EPIC-B / EPIC-C
  surface.
- **ADR 0018 (IME state machine)** — EPIC-E surface.

### 12.4 Related docs

- `docs/RELEASE.md` — updated here.
- `docs/terminal-benchmark-matrix.md` — updated here.
- `docs/technical-architecture.md` — updated here.
- `docs/perf-baselines.md` — referenced by §19.11 / §19.12; not modified
  here (EPIC-J owns).
- `docs/platform-matrix.md` — referenced by §19.13's cross-platform check;
  not modified here (EPIC-K owns).

---

## 13. Work breakdown

### 13.1 Day 0 — preflight (half-day)

- Open preflight gate issue.
- Attach evidence for each §19 row.
- Attach 1-week dogfood log.
- Human approver signs off.
- `grep -rln "@xterm/" packages/ crates/ tools/` baseline captured.

### 13.2 Day 1 — default flip + full CI

- Branch from main: `epic-I/xterm-removal`.
- Commit A: flip `data-renderer` default to `canvas`.
- Run full test matrix locally.
- Push; let CI run.
- Confirm all CI green; if red, revert commit A, re-diagnose, re-run §19
  evidence, halt.

### 13.3 Day 2 — source + deps deletion + full CI

- Commit B: delete every file in §3.1.1, remove `@xterm/*` from
  `package.json`, run `pnpm install --frozen-lockfile`, strip
  `tuiActive` / `needsAltScreen` / `altScreenVisible` from
  `TerminalPage.tsx`, audit-and-simplify-or-delete
  `entities/tui/`.
- Run full test matrix locally.
- Push; let CI run.
- Capture bundle-size delta; paste in PR description.
- Run grep verification (§4.3); paste output in PR description.
- Confirm all CI green; any red → follow-up commit on same PR, do NOT
  amend B.

### 13.4 Day 3 — docs + release + dogfood

- Commit C: ADR 0001 update; `terminal-benchmark-matrix.md`;
  `technical-architecture.md`; `RELEASE.md`.
- Push; let CI run.
- PR-ready: review + merge.
- Post-merge: open dogfood tracking issue, schedule 7-day review.

### 13.5 Days 4-10 — post-merge dogfood

- Daily dogfood entries (operator time + incident count).
- Any xterm-flagged incident (impossible but possible via mis-attribution)
  → P1 investigation.
- Day 10: close dogfood issue, flip DoD-31 to complete.

### 13.6 Day 11 (outside this epic's strict scope)

- RFC author opens PR flipping RFC 0001 status to Accepted.
- EPIC-I planning doc and implementation doc archived as historical.

---

## 14. Appendix — exact grep commands

Paste-ready commands the implementation agent runs at each gate. Kept in
one place so the review reproduces them 1:1.

```bash
# §5.1 — preflight baseline (Day 0)
grep -rln "@xterm/" packages/ crates/ tools/ | tee /tmp/pre-xterm-imports.txt

# §5.3 — post-delete verification (Day 2)
grep -rni "xterm" packages/ --exclude-dir=node_modules --exclude-dir=dist \
  | grep -v "historical-xterm-reference" \
  | grep -v "__tests__/fixtures/" \
  | grep -v "/compat/" \
  > /tmp/xterm-residual.txt
test ! -s /tmp/xterm-residual.txt  # exits 0 iff file is empty

# §5.3 — branching removal verification
grep -rn "tuiActive\|needsAltScreen\|altScreenVisible" packages/ui/src/ \
  > /tmp/legacy-branches.txt
test ! -s /tmp/legacy-branches.txt

# §5.3 — package.json verification
grep -l "@xterm/" packages/*/package.json packages/*/*/package.json 2>/dev/null \
  > /tmp/xterm-deps.txt
test ! -s /tmp/xterm-deps.txt

# §5.3 — lockfile verification
grep "@xterm/" pnpm-lock.yaml > /tmp/xterm-lockfile.txt
test ! -s /tmp/xterm-lockfile.txt
```

These commands are the literal form of the DoD predicates. The
implementation agent pastes their exit status into the PR description.

---

## 15. Appendix — relationship to RFC §2 I-10

RFC §2 I-10 states: "xterm is removed only after §19 gate is ALL-TRUE."

This epic is the only place in the repository where that invariant is
_exercised_ rather than _defined_. Every other epic enforces it
transitively (by not removing xterm themselves); this epic is the
execution. Therefore:

- The preflight gate in §3.2 IS the I-10 compliance check. The
  implementation agent does not have discretion to skip it, and the
  planning agent does not have authority to authorize the skip.
- The implementation agent who lands Commit B is the one human /
  machine-verified proof that I-10 was honored.
- The PR description permanently records the §19 evidence snapshot. If a
  future review asks "was the removal gate actually satisfied at the
  time?" the answer lives in the PR.

This is the only epic in the plan set with this structure. Treat it
accordingly.
