# Plan 0005 — Test Strategy & Compat Matrix

- **Status**: Live v1.4 (2026-04-21) — wave-4 close; 30 fixtures shipped.
- **Applies to**: P0 epics α / β / γ / δ / ε
- **Ship gate**: all tables here green on macOS + Linux in CI
- **Commit reference (wave-4 close)**: `f74c047`

---

## 0. Philosophy

Three-tier test strategy, no shortcuts:

1. **Unit** — pure-function tests on the VT engine, encoders, scrollback ring, write-batcher. Fast (< 5 s per file).
2. **Integration** — component tests that mount `SessionInputSurface` + `TerminalSurface` against a mock bridge. jsdom + React Testing Library.
3. **E2E / Compat** — golden-stream fixture tests. Feed a recorded PTY byte stream into the real engine pipeline, compare the resulting `GridSnapshot` to a committed expected snapshot. Also perf-budget enforced.

Every P0 exit gate has at least one test on each tier it spans.

---

## 1. Compat Matrix (the north star)

Every row below ships with:
- A byte stream (`packages/ui/fixtures/compat/<id>/input.bytes`) — synthetic for wave 1-4; recorded post-P0.
- Expected `GridSnapshot` checkpoints (`.../<id>/checkpoints.json`).
- Metadata envelope (`.../<id>/meta.json` — includes `id`, `kind`, `snapshotFormatVersion`; see §4.1).
- A generator script (`.../<id>/build-fixture.mjs`) documenting the scenario as code.
- A per-fixture `README.md` explaining scope + assertions.

Tests live at `packages/ui/src/__tests__/compat/<id>-<slug>.test.ts`.

Status legend (column "S"):
- ✓ — fixture on disk + integration test green as of `f74c047`.
- ⚑ — WIP in a parallel worktree; fixture scaffolding present but not yet merged (see §1.2).
- ∅ — dedup'd against another row; see rationale column.

| S | ID | Category | Scenario | Checkpoints |
|---|-----|----------|----------|-------------|
| ✓ | C-SH-01 | shell | bash: `ls`, `cd /tmp`, `pwd`, `echo $?` | cwd reports `/tmp`; prompt boundaries present |
| ✓ | C-SH-02 | shell | zsh: default prompt + 91-char hostname | wrap behavior matches xterm (DECAWM row-0 → row-1 spill) |
| ✓ | C-SH-03 | shell | fish: autosuggest visible | ghost text renders as bright-black; Tab accepts |
| ✓ | C-ED-01 | editor | vim: open 1000-line file, navigate, save, quit | alt-buffer enter, scroll, exit → main buffer restore byte-exact |
| ✓ | C-ED-02 | editor | nvim: LSP-enabled edit with diagnostics overlay | alt buffer + status line re-render |
| ✓ | C-ED-03 | editor | `vim :!bash` nested shell | modestack push/pop; inner bash prompt renders |
| ✓ | C-PG-01 | pager | `less /etc/passwd` + `j j j` + `/` search + `q` | alt-buffer enter, scroll, search highlight, exit → restore |
| ✓ | C-PG-02 | pager | `man git-log` | same as C-PG-01 plus long-line wrap |
| ✓ | C-PG-03 | pager | `more /etc/hosts` | single-screen pager; space to continue |
| ✓ | C-MON-01 | monitor | `top` for 30 s | 60 Hz paint, < 16 ms P99, < 150 MB RSS |
| ✓ | C-MON-02 | monitor | `htop` 30 s + `q` | same + alt-buffer exit restores |
| ✓ | C-MON-03 | monitor | `watch -n 0.1 date` 60 s | steady 10 Hz repaint, no layout jitter |
| ✓ | C-MUX-01 | mux | `tmux new`, split horizontal, split vertical, attach/detach | prefix C-b passes through outermost; inner tmux renders |
| ✓ | C-MUX-02 | mux | `tmux-in-ssh` depth 2 | mouse click reaches inner tmux via DECSET 1006 |
| ✓ | C-MUX-03 | mux | `tmux-in-ssh-in-tmux` depth 3 | mouse click reaches innermost; prefix reaches outermost |
| ✓ | C-NET-01 | network | `ssh localhost echo hi` | round-trip renders; no corruption |
| ✓ | C-NET-02 | network | remote bash over ssh with `cd /etc; ls` | cwd tracked via OSC 7 if integration injected, else heuristic |
| ✓ | C-RP-01 | repl | `python3`: `def foo():` → indented block → `foo()` | continuation prompt tagged; single run |
| ✓ | C-RP-02 | repl | `node`: multi-line paste | bracketed paste wraps; shell accepts |
| ✓ | C-RP-03 | repl | `psql -l` (skipped if no local psql) | table render |
| ✓ | C-COMB-01 | combinator | `git log \| less \| head -20` | pipe + pager; less exits via head closing stdin |
| ✓ | C-COMB-02 | combinator | `find / 2>/dev/null` | sustained output; no UI freeze > 100 ms |
| ✓ | C-COMB-03 | combinator | `yes \| head -c 1G` | 1 GB output; scrollback ring evicts; < 150 MB RSS |
| ✓ | C-UX-01 | ux | `clear` | grid clears to viewport; scrollback retained |
| ⚑ | C-UX-02 | ux | resize 200×50 → 80×24 → 200×50 (10x) | each resize < 16 ms; main buffer reflows; alt clears per xterm. Agent DD in-flight; scaffolding in `packages/ui/fixtures/compat/C-UX-02/build-fixture.mjs`; uses new `CheckpointExpected.resize` hook. Previously (wave-4) dedup'd in registry comment — reconciled to a live row once Agent DD lands. |
| ✓ | C-UX-03 | ux | copy/paste: select rows, Cmd+C, Cmd+V | grid selection → clipboard → bracketed paste → rendered |
| ∅ | C-UX-04 | ux | split pane: Cmd+D, Cmd+Shift+D, Cmd+\ | **Dedup'd (wave 4, Agent U)**: a true multi-pane scenario needs two independent sessions; the alt-buffer split-view variant is already covered by C-MUX-01 + C-MUX-02. See registry.ts comment block. Revisit in P1 when true split-pane chrome lands. |
| ✓ | C-IME-01 | ime | Korean 2-set: "안녕하세요" | recorded corpus byte-identical |
| ✓ | C-IME-02 | ime | Japanese IME: "こんにちは" via romaji | recorded corpus byte-identical |
| ✓ | C-IME-03 | ime | Chinese pinyin: "你好" | recorded corpus byte-identical |
| ✓ | C-IME-04 | ime | dead-key (European): `é` via `'` + `e` | recorded corpus byte-identical |
| ✓ | C-STRESS-01 | stress | `tail -f /dev/urandom \| base64` 30 s | frame-skip engages; no OOM; no dropped bytes |
| ✓ | C-STRESS-02 | stress | `cat 100mb.log` | scrollback eviction; 150 MB cap |
| ✓ | C-STRESS-03 | stress | DPR change mid-session (1x → 2x → 1x) | atlas invalidates; no artifacts |

### Acceptance

- **P0 ship = 100% green**, no skips, no "expected failure" stamps (unless explicitly platform-gated, e.g. psql).
- Windows: known-partial per RFC 0001 Epic K. Separate gate.

### 1.1 Deliverable count (wave-4 close, commit `f74c047`)

- **30 fixtures shipped** (✓ in column S above) across 33 total matrix rows.
- **1 fixture in-flight** (⚑ C-UX-02, Agent DD, wave-5).
- **2 rows dedup'd** with rationale (∅ C-UX-04; the earlier C-UX-02 dedup is superseded by Agent DD's upcoming landing).
- **89 compat tests green** (integration `describe.each` counts — multiple `it(...)` assertions per fixture).
- **0 `.fails` / skipped compat tests** in this window. Every shipped fixture runs as `it(...)`.

### 1.2 C-UX-02 reconciliation note

Wave 4 (Agents T/U/W) left a registry.ts comment claiming both C-UX-02 and C-UX-04 were dedup'd ("the compat harness only drives `emulator.feed()`; resize is a side-channel call"). That rationale was accurate at the time. Wave 3's audit (Agent S) then upgraded `compat-replay` to support an in-stream `resize` hook on `CheckpointExpected`, which makes C-UX-02 authorable again. Agent DD is landing it in a parallel worktree; on merge the registry.ts comment must drop C-UX-02 and keep only C-UX-04. Tracked in `gap-tracking.md` wave-5 table (Agent DD row).

---

## 2. Unit test surfaces

### 2.1 VtEmulator

New test files / expansions for Epic α:

- `__tests__/altbuffer.test.ts` — 1049/1047/47 entry/exit correctness (new)
  - vim fixture: enter-1049 saves main buffer; write to alt; exit-1049 restores main byte-exact.
  - Cursor position saved/restored on 1049 / 1048.
  - Alt-buffer cleared on 1047 entry.
  - Mode emit order: `ModeChanged{altScreen=true}` fires BEFORE first alt-buffer `GridDelta`.
- `__tests__/scrollback.test.ts` — new
  - Ring cap (10,000 rows default) honored.
  - Eviction policy: oldest row first.
  - Running-block pin: eviction refuses to cross pinned row.
  - Alt-buffer writes NEVER enter scrollback.
  - Scroll-up from main buffer appends to ring.
  - Resize reflow preserves scrollback content.
- `__tests__/resize.test.ts` — expand existing
  - 200×50 → 80×24 main buffer reflow: all text preserved, wrap re-computed.
  - Same resize on alt buffer: alt clears (xterm behavior).

### 2.2 Write-batcher (Epic γ)

- `__tests__/frame-skip.test.ts` — new
  - Frame-skip engages when render budget > 16 ms: verify paint deferred while bytes still flow into engine.
  - Byte-frame boundary preservation: CSI split across chunks never drops; OSC split never drops.
  - Sidecar flow-control hook invoked at soft cap (128 MiB).
  - Emergency drop ONLY at hard cap (256 MiB) AND flow-control unavailable.
  - Byte-accounting: bytes-in equals bytes-out (unless emergency drop, counted).

### 2.3 Input host (Epic β)

- `__tests__/always-on.test.ts` — new
  - `SessionInputSurface` mounted outside alt-screen: Ctrl+C encodes `\x03`, delivered to bridge.
  - Tab completion: Tab emits `\t` in non-alt-screen mode.
  - Focus: blur emits DSR 1004 focus-out when mode is on.
  - Paste large payload: `onPasteGate` fires with full text.

### 2.4 IME (Epic β carry-over)

Existing corpora (`kr-2set`, `jp-ime`, `cn-pinyin`, `deadkey`) must pass unchanged after session-scoped input-host migration. No new tests; regression gate only.

---

## 3. Integration tests (jsdom + RTL)

Covered tests (new or rewritten):

| Test | Epic | Purpose |
|------|------|---------|
| `__tests__/integration/terminal-surface.test.tsx` | α + β | Mount `<TerminalSurface />` + `<SessionInputSurface />` against mock bridge; feed bytes; verify grid state. |
| `__tests__/integration/no-block-ui-p0.test.tsx` | δ | P0 default renders plain grid; no BlockCard / Composer / ShellIntegrationBanner in DOM. |
| `__tests__/integration/alt-screen-transition.test.tsx` | α | Rewrite existing: DEC 1049h / 1049l swap buffers; `SessionInputSurface` stays mounted; chrome opacity unchanged. |
| `__tests__/integration/resize-streaming.test.tsx` | γ | Resize under live byte stream: no dropped bytes; reflow completes < 16 ms. |
| `__tests__/integration/frame-skip-under-load.test.tsx` | γ | Synthetic 50 MiB/s; paint frames skipped; grid ultimately consistent. |

---

## 4. E2E / Compat fixtures (recorded streams)

### 4.1 Fixture format

Each compat entry produces four files:

```
fixtures/compat/<id>/
  input.bytes              # raw PTY byte stream (synthetic — see §7)
  checkpoints.json         # array of { at_byte_offset, expected: CheckpointExpected }
  meta.json                # { id, kind, snapshotFormatVersion, shell, cols, rows, description, authoredAt }
  build-fixture.mjs        # regenerator script — `node build-fixture.mjs`
  README.md                # per-fixture doc (scenario, files table, synthetic rationale)
```

`meta.json` fields (Agent S's wave-3 audit upgrade, partial rollout across fixtures — remaining 19 tracked in wave-5 polish):
- `id` — matches registry key; harness-audit validates consistency.
- `kind` — `synthetic` for hand-authored (the entire wave 1-4 corpus); `recorded` reserved for future `tools/compat-record` output, with a `sourceSessionId` sibling. Advisory-only in wave 4; wave 5 promotes it to a harness-audit gate.
- `snapshotFormatVersion` — currently `1`. Bump when `CheckpointExpected` changes shape non-backwards-compatibly.
- `shell` / `cols` / `rows` / `description` / `authoredAt` — per-fixture metadata.

`CheckpointExpected` shape (in `packages/ui/src/__tests__/compat/compat-replay.ts`):

```ts
interface CheckpointExpected {
  readonly altScreen?: boolean;          // mode guard at this offset
  readonly cursor?: { row: number; col: number };
  readonly rows?: readonly RowProjection[];
  readonly scrollback?: { rowCount?: number; evictedCount?: number };
  readonly sgrDigest?: string;           // span-attribute digest (C-ED-01, C-PG-01, C-MON-02, etc.)
  readonly byteAccounting?: {            // Agent S wave-3: `feedBytes == inputBytes` guard
    readonly feedBytes?: number;
    readonly droppedBytes?: 0;
  };
  readonly resize?: { rows: number; cols: number };  // wave-3/4 addition, powers C-UX-02
}
```

`expected.rows[]` is a structural `GridSnapshot` projection — stable hashable form (grapheme per cell + optional per-cell width + SGR digest per row) + cursor row/col. NOT pixel snapshots — those diverge on font anti-aliasing.

#### In-stream side-channel hooks

Most fixtures drive the engine purely through `emulator.feed(bytes)`. A
couple of contracts (resize reflow, alt-buffer clear-on-resize, future
DPR transitions) can't be exercised by bytes alone, so the harness
accepts a small set of optional side-channel fields on
`CheckpointExpected`:

- `resize: { cols, rows }` — harness calls `emulator.resize(rows, cols)`
  at the checkpoint's byte offset BEFORE the diff runs. Row-index
  validation and row projection switch to the LIVE
  `emulator.getDimensions()` (not `meta.*`) so post-resize checkpoints
  see the new grid. Used by `C-UX-02` (10-cycle resize fixture); see
  `packages/ui/src/__tests__/compat/compat-replay.ts`.

Side-channel hooks stay strictly optional — every pre-existing fixture
continues to replay identically because the harness only diverges from
the feed-only path when the field is present.

### 4.2 Recording tool (deferred to post-P0)

A `tools/compat-record` CLI is specified here but **not yet implemented** — every fixture shipped in waves 1-4 is synthetic (hand-authored byte stream generated by `build-fixture.mjs`). Rationale: real recordings bring in terminfo/locale/shell-version noise, and the synthetic path lets reviewers audit every byte. Tracking the recorder itself against P1 (see `gap-tracking.md`).

Future shape:

```
$ tools/compat-record --shell zsh --cols 80 --rows 24 \
    --out fixtures/compat/C-ED-01 \
    -- vim /tmp/sample.txt
```

Would run the command in a real PTY, record bytes + key checkpoints (every 1 s + on mode-change events), write the fixture bundle. Idempotent — running twice with the same seed produces byte-identical output modulo timestamps, which are stripped at capture time. When landed, produces fixtures with `meta.json.kind = "recorded"` + `sourceSessionId` for provenance.

### 4.3 Replay harness

The production replay harness is a vitest integration module at `packages/ui/src/__tests__/compat/compat-replay.ts`. Every fixture gets a `C-*.test.ts` that reads `meta.json` + `input.bytes` + `checkpoints.json`, feeds the bytes through a fresh `VtEmulator`, and asserts each checkpoint's `expected` against the live grid. Audit invariants (Agent S wave 3): byteAccounting, snapshotFormatVersion, registry ↔ meta id match, scrollback-row projection bound. Cross-fixture audit sits in `harness-audit.test.ts`.

Ships in CI as part of the UI vitest run (`.github/workflows/compat.yml`).

### 4.4 Updating a fixture

Fixture divergence is a test failure by default. To update a synthetic fixture, edit its `build-fixture.mjs` and re-run:

```
$ node packages/ui/fixtures/compat/<id>/build-fixture.mjs
```

This regenerates `input.bytes` + `checkpoints.json` in place. The diff is reviewer-audited — the generator script IS the human-readable source of truth; never edit `input.bytes` by hand. No auto-update in CI.

(Recorded fixtures, when the recording tool lands, will support a `--update` flag on `tools/compat-record`.)

---

## 5. Perf harness (Epic ε / γ)

Status: **scaffolded** (Agent M, wave 3). Runner: `tools/run-perf-budget.mjs`. Tests: `packages/ui/src/__tests__/perf/` (4 budget tests + `perf-budget.ts` + `fixtures.ts`). Vitest config gates the suite behind the `VITEST_PERF=1` opt-in to keep the default test run fast. CI runs it separately via `.github/workflows/perf.yml`. Cross-plan baseline numbers for the Rust stages live in `docs/perf-baselines.md` (RFC 0001 §13.12).

### 5.1 Budgets

The following table lists the committed P0 UI-side budgets (rationale attached; each row traces to a `ship-gate` exit criterion in README §12).

| Metric | Budget | Rationale | How measured |
|--------|--------|-----------|--------------|
| Frame paint P99 | 16 ms | 60 Hz target; covers the entire `GridSnapshot → Canvas2D` path. | `performance.measure` wrapping `Renderer.paint()` |
| Keystroke → PTY byte P99 | 2 ms | Keeps I/O latency invisible on a 16-ms frame. | Test-only timestamp bracket around `encodeKey → write` |
| Resize duration | 16 ms avg, 32 ms P99 | One frame avg; two-frame P99 accommodates reflow cost. Verified against C-UX-02 (wave 5). | `performance.measure` on `VtEmulator.resize()` |
| Memory steady-state | 150 MB RSS | Empirical ceiling from `top`/`htop` 60 s fixtures; headroom over the 128 MiB soft cap. | `process.memoryUsage()` sampled every 1 s during 60 s monitor fixture |
| VtEmulator.feed() CPU per 1 KiB | 0.5 ms P99 | Targets ≥ 2 MiB/s sustained feed under one frame, with room for parse-heavy sequences (CSI/OSC). | Microbenchmark |

### 5.2 CI enforcement

`pnpm test:perf` (alias wraps `VITEST_PERF=1 pnpm --filter @quanta/ui vitest run src/__tests__/perf`) runs per PR against a fixed fixture set:

- `top -d 0.1` 60 s: C-MON-01 budget
- `watch -n 0.1 date` 60 s: C-MON-03 budget
- `yes \| head -c 1G`: C-STRESS-02 budget
- Resize cycle: C-UX-02 budget (green when Agent DD's fixture merges)

Budget violations block the PR. Regressions within 10% of budget emit a warning but pass. See `.github/workflows/perf.yml` for runner config.

### 5.3 Flake policy

Perf budgets assumed on a 4-core Linux runner (GitHub Actions `ubuntu-latest`). macOS runner budgets are +20% (hardware variance). Tests run 3 times; median is the judgement metric. Two-of-three below budget = pass.

---

## 6. Byte-accounting (invariant enforcement)

Every compat test instruments:

- `input_bytes_total` at the PTY → batcher boundary.
- `feed_bytes_total` at `VtEmulator.feed()`.
- `dropped_bytes_total` (emergency only).

Assertion: `input = feed + dropped`. Any mismatch = critical failure. In P0 happy path, `dropped = 0`.

---

## 7. Golden corpus authoring policy

- P0 corpus is **synthetic**: every wave 1-4 fixture is hand-authored via a `build-fixture.mjs` generator that reviewers can audit byte-by-byte. Original plan anticipated real recordings, but the `tools/compat-record` harness lands post-P0 (see §4.2); synthetic bytes exercise the same `VtEmulator.feed()` + grid / scrollback paths and let the reviewer inspect the scenario as code, not as an opaque capture.
- Generator scripts committed alongside the fixture bundle under `packages/ui/fixtures/compat/<id>/build-fixture.mjs`. The generator IS the source of truth — never edit `input.bytes` by hand.
- Recorded (`kind: recorded`) fixtures are permitted once `tools/compat-record` lands; meta.json carries `sourceSessionId` for provenance.
- Any change to an existing fixture requires: re-run of `build-fixture.mjs` + an ADR update if it changes terminal semantics + an explicit commit message note for recording noise.
- New shell versions may re-record; the expected snapshots are recomputed deterministically.

---

## 8. Test debt we carry in

Existing tests in `packages/ui/src/__tests__/e2e/` (see §0 survey) mostly assert the LEGACY path (BlockCard rendering, Composer submit semantics). P0 breaks that path.

Migration policy:
- Tests that assert terminal behavior (keystroke → byte, alt-screen, resize, IME, paste) are MIGRATED to new `__tests__/integration/` or `__tests__/compat/` directories with rewrites.
- Tests that assert block-UX behavior (BlockCard render, Composer autosuggest, path completion popup) are MOVED to `__tests__/p1-block-ux/` and gated on `flag.blockUx === true`. They remain passing under P1 flag.
- Tests that assert degraded / crash-recovery flows: keep, update mocks for new input-host entry point.
- Pure unit tests (encoders, VtEmulator, GridMirror): keep, extend.

Inventory of moved-to-P1 tests will be tracked in a migration checklist during Epic δ.

---

## 9. Ship checklist (Plan 0005 P0) — final state

State taken at commit `f74c047` (wave-4 close). Full per-gate status with evidence lives in `gap-tracking.md` ("P0 ship gate scorecard"); when `SHIP_SIGNOFF.md` lands it supersedes the checkmarks below. Numbering mirrors README §12 (1-12).

1. [x] Zero `block.outputChunks` accesses in default render path. Evidence: `tools/check-one-render-path/` strict-clean; CI in `grep-rules.yml`.
2. [x] Zero non-SessionInputSurface paths to `bridge.write`. Evidence: `tools/check-one-input-path/` strict + 2 DEFER (`execute.ts` legacy helpers, P1-C cleanup); TuiRenderSurface DSR migrated by Agent-L.
3. [x] Zero ANSI parsing outside VT engine in prod paths. Evidence: `shared/lib/text/project-output` migration (Agent-I); 2 DEFER behind `flag.blockUx`.
4. [x] DEC 1049/1047/47 fully implemented + tested. Evidence: `altbuffer.test.ts` + `altbuffer-edge.test.ts` + 89 compat tests.
5. [x] Scrollback ring live with cap + eviction + pinning. Evidence: `scrollback.test.ts` + `scrollback-edge.test.ts` + C-STRESS-02 cap-enforce.
6. [x] Compat matrix green on macOS + Linux — 30/33 shipped (§1; 2 dedup'd, 1 WIP C-UX-02 → flips on Agent DD merge). Evidence: `packages/ui/src/__tests__/compat/*.test.ts`; CI `.github/workflows/compat.yml`.
7. [~] Perf budgets green in CI. Harness scaffolded (`tools/run-perf-budget.mjs` + `__tests__/perf/`), budgets committed with rationale (§5.1); CI workflow in `.github/workflows/perf.yml`. Green-at-budget verification pending full-suite run.
8. [x] vim round-trip byte-exact main buffer 100 iterations. Evidence: C-ED-01 + `altbuffer.test.ts`.
9. [x] KR IME byte-identical to corpus. Evidence: `features/input/ime/__tests__/kr-2set-corpus.test.ts` + C-IME-01 render.
10. [x] `yes` / `tail -f` / `watch` run 60 s without OOM or data loss (engine-level). Evidence: C-STRESS-01/02 + C-MON-03 + global `byteAccounting.droppedBytes === 0` in `harness-audit.test.ts`.
11. [x] Sidecar flow-control engages before last-resort drop. Evidence: `packages/host-tauri/src-tauri/src/flow_control.rs` (Agent-N) + 13 Rust tests + 5 TS wiring tests.
12. [x] Default UI after fresh session: plain grid, no block chrome. Evidence: `flag.blockUx=false` default + `p0-default.test.tsx` + `TerminalPage` P0/P1 gate (Agent-J).

Legend: [x] landed with evidence; [~] partial (impl landed, verification pending); [ ] not started.

P0 shipped to staging at commit `fab7198` (see `SHIP_SIGNOFF.md`) with **11 [x] / 1 [~]** — gate 7 perf green-at-budget absorbed into P1-H wave 2. The wave-4 scorecard (count at `f74c047`) remains the intermediate reference above.

P1 wave 1 landed at `868e482` with 9 spine-complete epics (see `gap-tracking.md` "P1 wave 1 landed"); the P1 done-definition mirrors this P0 checklist (12 gates — see README §12.1 and `p1-roadmap.md` §"Done definition") and stands at **3 [x] / 6 [~] / 3 [ ]** post-wave-1. Wave-2 closes the remainder. The P2 execution-surface spec lives in [p2-roadmap.md](./p2-roadmap.md).
