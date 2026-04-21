# Plan 0005 P2 Roadmap

- **Status**: draft (2026-04-21) — authored after P1 wave 1 close at `868e482`; all epics gated on P1 done-definition green.
- **Entry commit**: `868e482` (P1 wave 1 landing); wave-2 completion is the hard precondition.
- **P1 status**: 9 spines landed; wave-2 polish + integration in flight (see p1-roadmap.md "Wave 1 status" per epic + gap-tracking.md "Wave 1 deltas").
- **Authors**: Engine team
- **Reads-from**: [README.md §7](./README.md#7-p2--execution-surface-scheduled-after-p1), [p1-roadmap.md](./p1-roadmap.md), [gap-tracking.md](./gap-tracking.md), [test-strategy.md](./test-strategy.md)

---

## Overview

P0 made Quanta an xterm-replaceable terminal — one engine, one input path, one render path, bounded scrollback, shipping compat matrix. P1 put a Warp-replaceable block surface on top — hybrid OSC 133 / heuristic / idle boundary detection, absolute-overlay block chrome that never touches bytes, mode-stack awareness for pagers / tmux / REPLs, session restore, scrollback-wide search, ghost hints, and a regression-guarded CI.

**P2 turns the terminal into an execution surface.** The `Run` is the unit — every command, every agent invocation, every replay, every pipeline stage is a typed lifecycle with inputs, outputs, timing, and resource usage. The `Intent` is the action — user keystrokes and agent tool calls are lifted from untyped bytes into meaning-typed actions that can be intercepted, rewritten, gated, or suggested. Priority backpressure replaces frame-skip-only — output classes (`control` / `visible` / `scrollback` / `verbose`) let the system drop cosmetic bytes under load while preserving the error message the user is debugging. Structured output types turn `table` / `progress` / `json-stream` / `binary` into first-class chrome hints. The agent surface renders tool calls as Runs with type-discriminated chrome — parity between human and agent work.

These are not seven independent features. They compose: **Intent** produces **Runs**; **Runs** stream output under **priority backpressure** with **structured type hints**; **agent tool calls** are **Intents** that spawn **Runs**; **per-run resource usage** attaches telemetry; **replay UX** mounts historical **Runs** into the live UI using the P1-E journal. Every epic assumes its upstream neighbours exist.

P2 is a multi-wave rollout — the seed for **P2-A Run entity** lands inside P1 wave-2-D (so P1-C's `Block` can become a projection of `Run` cleanly rather than a retrofit), and wave-3 completes the P2 surface. P2 is where Plan 0005 converges with the broader Plan 0004 (plugin system) and future Plan 0006+ (agent OS) lines — the Run / Intent / Priority triad is the contract surface those plans bind to.

Rollout is sequenced: **A → B → {C, D}** parallel; **E depends on B + A**; **F depends on A**; **G depends on A + P1-E**. All P2 epics land flag-gated (default off) until a done-definition pass flips them in.

---

## Epic P2-A — Run entity

### Goal

Promote `Block` from "row range + boundary" to `Run` — a first-class lifecycle with explicit states (`pending` / `running` / `exited` / `failed` / `aborted`), typed inputs + outputs, timing + exit metadata, and a projection surface that P1-C's overlay chrome can re-consume. `Block` becomes a view over `Run`, not the other way around. Unlocks agent-as-Run (P2-E), resource-usage attachment (P2-F), and replay mount (P2-G).

### Entry state

- P1-C landed `widgets/block-overlay/` reading grid row ranges via `rowRange` schema on the `Block` entity (`entities/block/model.ts`).
- P1-A produces boundary events with confidence + exit code (`features/command/hybrid-detector.ts`).
- P1-E journal (`features/session-restore/`) persists PTY + input + mode deltas with a versioned format; `Run` serialisation extends the schema, not replaces it.
- `entities/block/persistence.ts` persists metadata to IndexedDB.
- No `Run` type; no lifecycle state machine; no agent / replay distinction at the entity layer.

### Exit state

- `entities/run/model.ts` defines `Run = { id, kind: 'command' | 'agent-tool-call' | 'replay-frame' | 'pipeline-stage', state, intent?, rowRange, startedAt, completedAt?, exit?, resource?, parent?, children: RunId[] }`.
- `features/command/block-boundary-listener.ts` creates a `Run` on boundary start; finalises on boundary end. `Block` becomes `selectRunAsBlock(runId)` projection in `entities/block/selectors.ts`.
- `Run` state machine is pure, documented in ADR 0023, covered by exhaustive-transition tests.
- `widgets/block-overlay/` reads from `Run` projections; no code-path regression vs P1-C at wave-1 close.
- Run persistence (P1-E journal integration) lives under the v2 schema with forward-compat migration from v1.
- `Run` parent / child tree models pipelines (`a | b | c` → one parent Run, three child Runs) and agent tool calls spawned inside a user Run.

### Work items

A1. New `packages/ui/src/entities/run/model.ts` — `Run` type + state machine (`pending → running → exited | failed | aborted`; no other transitions). Pure; zero React. Exports `createRun(params)`, `transition(run, event)`, `isTerminal(state)`.
A2. New `packages/ui/src/entities/run/store.ts` — zustand slice with `createRun` / `updateRun` / `terminate` / `abort` actions; selectors (`selectRunById`, `selectRunsInRange`, `selectChildRuns`). Replaces `block-store-port` for the canonical run-level API; `Block` store becomes a derived projection.
A3. Refactor `features/command/block-boundary-listener.ts` — produce `Run.create('command')` on `prompt_start`; transition on `command_end` with exit code; attach confidence from hybrid detector.
A4. Migration: `entities/block/selectors.ts` gets a `selectRunAsBlock(runId)` helper; existing `selectBlockById` delegates. `widgets/block-overlay/BlockOverlay.tsx` still reads `Block` — no widget rewrite in this wave.
A5. Pipeline detection: when the hybrid detector sees `|`-style pipe syntax in the command-start payload (OSC 133 C), spawn child Runs per stage. Pure heuristic — no shell parse; fallback to single Run on ambiguity.
A6. Journal schema v2 in `features/session-restore/journal-format.ts` — adds `Run` records alongside existing PTY / input records. Forward-compat migration from v1 (v1 = derive synthetic Runs from block boundaries). ADR 0027 amendment.
A7. New `entities/run/__tests__/model.test.ts` — state-machine exhaustion (5 states × all events); illegal-transition assertions.
A8. New `entities/run/__tests__/store.test.ts` — CRUD + pipeline parent / child + journal roundtrip.
A9. Metrics: `quanta.run.created_total{kind}`, `quanta.run.duration_p99_ms{kind}`, `quanta.run.terminal_state_total{state}`.
A10. ADR 0023 authoring (deferred from P0 §11) — the Run entity contract.

### Exit gates

- **E-A-01** `entities/run/__tests__/model.test.ts` exhaustive state-machine transitions; ≥ 95 % branch coverage; zero illegal-transition leaks.
- **E-A-02** `entities/run/__tests__/store.test.ts` CRUD + pipeline parent / child + child-run lifecycle.
- **E-A-03** Integration: P1-C block overlay renders unchanged when `flag.runEntity === true` (projection parity). Diff against wave-1 BlockOverlay snapshots = zero.
- **E-A-04** Journal migration: a v1 journal loads cleanly under v2 code; synthetic Runs derived match live-recorded Runs byte-identical on replay.
- **E-A-05** Pipeline fixture: `git log | grep foo | head -5` produces one parent Run + three child Runs with ordered timing.

### Dependencies

- P1-A (boundaries + exit codes).
- P1-C (block overlay + rowRange schema — Run becomes the canonical, Block the projection).
- P1-E (journal — v2 schema + migration).

### Effort bucket

**large** (new entity + state machine + journal migration + projection layer + ADR).

### Risks + mitigations

- **R-A-1** Refactoring `entities/block/` breaks readers outside P1-C (AI explain, export, compare). *Mitigation*: `selectRunAsBlock` shim keeps the `Block` shape stable; deletion of `Block` entity deferred to P3 if ever.
- **R-A-2** Pipeline child-Run detection is heuristic; a command like `echo "a|b"` would spuriously split. *Mitigation*: require OSC 133 C payload to contain the un-escaped pipe; ambiguous payloads collapse to single Run. Compat fixture covers escaping.
- **R-A-3** Journal v1 → v2 migration fails on corrupted headers. *Mitigation*: format-version guard at read; corrupt journals log + fall back to "no restore available"; no data-loss path.
- **R-A-4** Zustand store depth increases with `Run` + existing `Block` + `Intent` (P2-B); performance regression on 10k-run sessions. *Mitigation*: store-slicing + memoised selectors; perf test in E-A-03.

### Files

- **New**: `packages/ui/src/entities/run/model.ts`
- **New**: `packages/ui/src/entities/run/store.ts`
- **New**: `packages/ui/src/entities/run/selectors.ts`
- **New**: `packages/ui/src/entities/run/__tests__/model.test.ts`
- **New**: `packages/ui/src/entities/run/__tests__/store.test.ts`
- **Update**: `packages/ui/src/features/command/block-boundary-listener.ts` (produce Run events)
- **Update**: `packages/ui/src/entities/block/selectors.ts` (`selectRunAsBlock` shim)
- **Update**: `packages/ui/src/features/session-restore/journal-format.ts` (schema v2)
- **Update**: `docs/adr/` — author **ADR 0023 Run entity** (deferred from P0 §11).

---

## Epic P2-B — Intent layer

### Goal

Lift user keystrokes, composer submissions, and agent tool calls from raw byte streams into typed `Intent` records — `{kind, payload, source, timestamp}` — that can be intercepted by middleware (AI suggest, secret-redact, safety gate, rewriter, explainer) before bytes touch `input-host`. `Intent` is the action; `Run` is the result. The composer becomes an Intent emitter; agent SDKs become Intent emitters; the same middleware stack serves both.

### Entry state

- P0 β established `SessionInputSurface` as the single byte path; all keystrokes route through `input-host.ts` encoders (`KeyEncoder`, `MouseEncoder`, `PasteEncoder`, etc.).
- `features/ai-suggest/` and `features/ai-explain/` exist but operate post-hoc on block output.
- `features/secret-detect/` exists but only scans PTY bytes post-emit.
- No unified middleware pipeline; every consumer sniffs its own interception point.
- No first-class "intent" type — the composer's `submitCommand` just calls `bridge.write(text + "\n")`.

### Exit state

- `features/intent/types.ts` defines `Intent = { id, kind: 'keystroke' | 'submit-command' | 'agent-tool-call' | 'paste' | 'signal', payload, source: 'user' | 'agent' | 'replay', runId?, timestamp }`.
- `features/intent/router.ts` is the single funnel — `SessionInputSurface` + composer + agent SDK all call `router.dispatch(intent)`; middleware chain runs; final bytes go to `input-host`.
- Middleware protocol: `(intent, next) => Promise<IntentOutcome>`; outcomes are `{bytes, newIntent?, rejected?, reason?}`.
- Built-in middleware (all flag-gated, composable):
  - `secret-redact` — scans payload, rewrites to `[REDACTED]` or rejects with reason.
  - `safety-gate` — blocks `rm -rf /` patterns and logs.
  - `ai-rewriter` — optional; rewrites natural-language to shell.
  - `ai-explain` — attaches `{explanation}` metadata; does NOT modify bytes.
- Every emitted byte carries `runId` provenance for P2-A attribution.

### Work items

B1. New `packages/ui/src/features/intent/types.ts` — `Intent`, `IntentKind`, `IntentSource`, `IntentMiddleware`, `IntentOutcome`.
B2. New `packages/ui/src/features/intent/router.ts` — middleware chain with timeout, composable `use(middleware)` API, telemetry.
B3. Migrate `SessionInputSurface` → `features/intent/session-intent-bridge.ts` that constructs `Intent{kind: 'keystroke'}` records and dispatches through the router. `input-host` becomes the router's "write adapter" at chain end.
B4. Composer submit path: `features/command/execute.ts` `submitCommand` creates `Intent{kind: 'submit-command'}`. Agent SDK (future) uses the same factory.
B5. New `features/intent/middleware/secret-redact.ts` — wraps `features/secret-detect/`; inspects payload strings, rewrites / rejects. Default-on.
B6. New `features/intent/middleware/safety-gate.ts` — pattern-based prompt-before-write for destructive commands; default-on; configurable patterns list under `resources/safety-patterns/`.
B7. Rewire `features/ai-suggest/` as an Intent middleware that produces `newIntent` suggestions without rejecting the original; UI binds to router's suggestion stream.
B8. ADR 0024 authoring — Intent router policy (deferred from P0 §11).
B9. Metrics: `quanta.intent.dispatched_total{kind,source}`, `quanta.intent.rejected_total{middleware,reason}`, `quanta.intent.latency_p99_us`.
B10. Byte-accounting invariant extension: every PTY byte carries an `intentId`; dangling bytes (no intent) are a critical error in dev-mode.

### Exit gates

- **E-B-01** `features/intent/__tests__/router.test.ts` — chain composition, middleware reject / rewrite, timeout, chain-bypass on error.
- **E-B-02** `features/intent/middleware/__tests__/secret-redact.test.ts` — 30 corpus entries (credit-card, private key, password).
- **E-B-03** `features/intent/middleware/__tests__/safety-gate.test.ts` — `rm -rf /`, `dd if=/dev/zero`, `mkfs.ext4` trigger prompt; harmless `rm -rf ./build` doesn't.
- **E-B-04** Integration: `input-host` byte-accounting — every byte carries `intentId` provenance in traces; 0 dangling bytes in a 60s compat run.
- **E-B-05** AI suggest regression: existing `features/ai-suggest/` tests pass under the middleware model with no UX regression.

### Dependencies

- P2-A (Intent records attach `runId` once a Run is available; Intent without Run is valid but Intent-produced bytes create new Runs).

### Effort bucket

**large** (new middleware architecture, byte-path refactor, AI-surface migration, ADR).

### Risks + mitigations

- **R-B-1** Middleware chain adds latency; keystroke → byte P99 budget (2 ms) might bust. *Mitigation*: fast-path for `{kind:'keystroke', source:'user'}` with no middleware configured; full chain only on composer submit + agent calls.
- **R-B-2** Secret-redact false-positives on sourced-in env vars (`export API_KEY=...`) that the user legitimately wants to emit. *Mitigation*: allowlist gate — `[confirm]` chip in the banner; telemetry captures rejections for corpus refinement.
- **R-B-3** Safety-gate prompt interrupts automation. *Mitigation*: `source: 'agent'` intents have a separate gate policy (default stricter); `source: 'replay'` bypasses safety-gate entirely.
- **R-B-4** AI middleware hang breaks typing. *Mitigation*: chain timeout default 50 ms for keystroke-source, 2 s for submit-source.

### Files

- **New**: `packages/ui/src/features/intent/types.ts`
- **New**: `packages/ui/src/features/intent/router.ts`
- **New**: `packages/ui/src/features/intent/session-intent-bridge.ts`
- **New**: `packages/ui/src/features/intent/middleware/secret-redact.ts`
- **New**: `packages/ui/src/features/intent/middleware/safety-gate.ts`
- **New**: `packages/ui/src/features/intent/middleware/ai-suggest-middleware.ts`
- **New**: `packages/ui/src/features/intent/__tests__/router.test.ts`
- **New**: `packages/ui/src/features/intent/middleware/__tests__/secret-redact.test.ts`
- **New**: `packages/ui/src/features/intent/middleware/__tests__/safety-gate.test.ts`
- **Update**: `packages/ui/src/features/session/SessionInputSurface.tsx` (dispatch via router)
- **Update**: `packages/ui/src/features/command/execute.ts` (submit emits Intent)
- **Update**: `docs/adr/` — author **ADR 0024 Intent router** (deferred from P0 §11).

---

## Epic P2-C — Priority backpressure

### Goal

Replace P0's frame-skip-only + emergency-drop policy with a priority-classified output policy. Every output byte carries an implicit class (`control` / `visible` / `scrollback` / `verbose`); under sustained load, `verbose` drops first, `scrollback` next, then `visible` retreats to frame-skip, with `control` guaranteed lossless. Solves "first-version drops log bytes" vs "under flood the UI freezes" tension that P0 deferred.

### Entry state

- P0 γ delivered `WriteBatcher` frame-skip + sidecar flow-control + emergency-drop-scrollback-oldest. All bytes are currently single-class.
- P1-A's hybrid detector reliably emits OSC 133 boundaries on dogfood, which makes "control" events identifiable at parse time.
- `VtEmulator` ingestion is single-queue; no priority lanes.
- Emergency drop is untyped — drops oldest rows blindly.

### Exit state

- `shared/lib/write-batcher-frame-skip.ts` extended with a priority lane model: 4 queues (`control`, `visible`, `scrollback`, `verbose`), feed order = priority order.
- Byte-classifier at the PTY → batcher boundary: `features/backpressure/classify.ts` tags each byte range with a class based on VT parser state + OSC 133 context.
  - `control` = OSC 133 / 7 / 1337; DEC mode changes; mouse / focus / paste sequences.
  - `visible` = viewport-targeted text + SGR.
  - `scrollback` = text that would immediately scroll out (detected post-hoc when row evicts within < 2 frames of emit).
  - `verbose` = traffic from known-verbose sources (e.g. `tail -f` on a log file recognised via cwd + heuristic; opt-in via shell integration `QUANTA_VERBOSE` hint).
- Drop policy under sustained 256 MiB+ soft cap: `verbose` drops first; `scrollback` next; `visible` falls back to frame-skip + sidecar flow-control; `control` is lossless (separate lane, never batched).
- Metric surfaces: dropped bytes by class; UI banner "verbose output throttled" on `verbose` drop.

### Work items

C1. New `packages/ui/src/features/backpressure/classify.ts` — byte classifier; consumes `VtEmulator` parse-state hook; emits `{class, bytes}` ranges.
C2. Extend `shared/lib/write-batcher-frame-skip.ts` — add `PriorityQueue` with 4 lanes; feed ordering preserved per lane.
C3. `control` lane bypass — byte-frame boundary is preserved at lane boundary; control bytes never block on a slow `verbose` flush.
C4. Verbose classifier heuristics: shell integration hook `QUANTA_VERBOSE=1` sourced in rc; output from that command gets `verbose` class.
C5. Post-hoc scrollback reclass: a byte that emits to a row which is evicted within 2 frames gets reclassified to `scrollback` for stats + future-drop-priority tuning.
C6. UI surface: "throttled" banner with class-breakdown stats (`widgets/throttle-banner/`); drops notification in a "View dropped output" panel.
C7. ADR 0025 authoring — Priority classes + drop policy (deferred from P0 §11).
C8. Byte-accounting: every dropped byte accounted under class; `input = feed + dropped_by_class`; `dropped_control = 0` is a hard invariant.
C9. Metrics: `quanta.backpressure.dropped_bytes_total{class}`, `quanta.backpressure.queue_depth_gauge{class}`, `quanta.backpressure.control_bypass_total`.
C10. Integration with P2-A: `Run.output_dropped` carries per-class counts so the overlay can render "23 KB verbose dropped" in the footer.

### Exit gates

- **E-C-01** `features/backpressure/__tests__/classify.test.ts` — 40 corpus scenarios; control lane identification ≥ 99 % accurate.
- **E-C-02** `shared/lib/__tests__/write-batcher-priority.test.ts` — lane ordering under load; control-bypass preserves byte-frame boundaries.
- **E-C-03** Compat fixture `C-BP-01-verbose-throttle`: `tail -f /dev/urandom | base64` hits the `verbose` drop path before `scrollback`; UI banner shown; control bytes (SGR / OSC) all delivered.
- **E-C-04** Invariant: `dropped_control === 0` across all compat runs.
- **E-C-05** Perf: priority classifier adds ≤ 0.1 ms per 1 KiB to `VtEmulator.feed` CPU budget (microbench).

### Dependencies

- P2-A (Run.output_dropped field for UI attribution).
- P1-A (OSC 133 context needed for reliable `control`-class detection; heuristic fallback exists).

### Effort bucket

**medium** (classifier + queue extension + UI; existing batcher architecture is the heavy lift — this is a refinement).

### Risks + mitigations

- **R-C-1** Verbose classifier misses a genuinely verbose command → user sees freeze. *Mitigation*: shell integration `QUANTA_VERBOSE` hint + telemetry for "scrollback-evicted bytes per command" to identify auto-classify candidates.
- **R-C-2** Reclassification race — byte classified as `visible`, reclassified to `scrollback` after drop decision made. *Mitigation*: classification is drop-time only; reclassification is stats-only.
- **R-C-3** Control lane bypass breaks byte ordering (OSC 133 D arrives before the command's last `visible` byte). *Mitigation*: control bypass only applies to sequences VtEmulator handles out-of-order anyway (mode changes, DSR responses); linear output within a Run stays ordered.
- **R-C-4** `verbose` drop hides a real error message the user was searching for. *Mitigation*: never drop bytes within 5 s of a `Run` terminating with non-zero exit; those belong to the error context window.

### Files

- **New**: `packages/ui/src/features/backpressure/classify.ts`
- **New**: `packages/ui/src/features/backpressure/priority-queue.ts`
- **New**: `packages/ui/src/features/backpressure/__tests__/classify.test.ts`
- **New**: `packages/ui/src/shared/lib/__tests__/write-batcher-priority.test.ts`
- **New**: `packages/ui/src/widgets/throttle-banner/ThrottleBanner.tsx`
- **New**: `packages/ui/fixtures/compat/C-BP-01-verbose-throttle/` (+ test)
- **Update**: `packages/ui/src/shared/lib/write-batcher-frame-skip.ts` (priority lanes)
- **Update**: `packages/host-tauri/resources/shell-integration/{bash,zsh,fish}` (`QUANTA_VERBOSE` hook)
- **Update**: `docs/adr/` — author **ADR 0025 Priority classes** (deferred from P0 §11).

---

## Epic P2-D — Structured output types

### Goal

Extend `Run` output metadata with structural type hints — `table` / `progress` / `json-stream` / `binary` — so block chrome can render domain-appropriate affordances (sortable tables, progress bars, expandable JSON trees, binary previews) instead of monospace text. Producers emit OSC 1337-style hints or shell-integration helpers; consumers degrade to plain text when the hint is absent.

### Entry state

- P2-A `Run.kind` models lifecycle; `output` is untyped grid rows.
- `widgets/block-overlay/` renders row ranges via `shared/lib/text/project-output` (plain text only).
- OSC 1337 iTerm2 extension is parsed by the Rust VT but only surfaces cwd + image hints today.
- No table / JSON / progress semantics in the chrome layer.

### Exit state

- `Run.outputHints: OutputHint[]` carries `{kind, startOffset, endOffset, payload}` — e.g. `{kind: 'table', columns: ['name','size'], rows: [['a','1'],['b','2']]}`.
- Block overlay conditionally renders typed chrome — a `TableView`, `ProgressBar`, `JsonTree`, or `BinaryPreview` — when hints are present; falls back to the P1-C plain-text projection otherwise.
- Producers:
  - OSC 1337 `File=` for `binary`.
  - New OSC `1338;table=...` payload (Quanta-specific, documented in shell-integration).
  - `progress` inferred from `\r`-overwrite-prefix heuristic + optional OSC 9 progress hint.
  - `json-stream` detected from a line-delimited JSON heuristic (first char `{` or `[`, valid JSON per line).

### Work items

D1. New `packages/ui/src/entities/run/output-hints.ts` — `OutputHint` types (table / progress / json-stream / binary).
D2. New `packages/ui/src/features/output-hints/detect.ts` — hint detectors; OSC 1338 parser + heuristic fallbacks for progress / json-stream.
D3. Extend `shared/lib/vt-emulator/` OSC dispatcher to emit OSC 1338 events (leverages P1-A osc-subscribe surface).
D4. New `widgets/block-overlay/hints/TableView.tsx` — sortable, copyable.
D5. New `widgets/block-overlay/hints/ProgressBar.tsx` — bound to `\r`-overwrite frames.
D6. New `widgets/block-overlay/hints/JsonTree.tsx` — lazy-expand; 10k-line perf tested.
D7. New `widgets/block-overlay/hints/BinaryPreview.tsx` — base64 inline for small images; file-size stamp for large.
D8. Shell integration helpers: `quanta_table()`, `quanta_progress()` bash / zsh / fish functions emit OSC 1338.
D9. Fallback path — any hint render that errors falls back to plain-text projection; hints are purely additive.
D10. Metrics: `quanta.output_hints.detected_total{kind}`, `quanta.output_hints.render_error_total{kind}`.

### Exit gates

- **E-D-01** `features/output-hints/__tests__/detect.test.ts` — 20 scenarios each for progress / json-stream / table / binary; false-positive rate < 1 %.
- **E-D-02** `widgets/block-overlay/hints/__tests__/TableView.test.tsx` — sort, copy, 10k-row render under 50 ms.
- **E-D-03** Integration: sample session with `quanta_table`-wrapped `ps` output renders TableView; plain `ps` falls back to text.
- **E-D-04** Degradation: corrupt JSON in a `json-stream`-classified output falls back to plain-text with no crash.
- **E-D-05** Perf: hint detection adds ≤ 0.05 ms per 1 KiB to feed budget.

### Dependencies

- P2-A (Run.outputHints field).
- P1-C (block overlay chrome is the render surface).

### Effort bucket

**large** (four widget primitives + detector + shell integration — each widget is a mini-feature).

### Risks + mitigations

- **R-D-1** JSON-stream heuristic false-positives on log lines that happen to start with `{`. *Mitigation*: require ≥ 3 consecutive valid-JSON lines before classifying; OSC 1338 hint is authoritative.
- **R-D-2** TableView on 1M-row output OOMs. *Mitigation*: virtualised row window; pagination UI; "download as CSV" fallback.
- **R-D-3** Binary preview auto-renders a 4K image the user didn't want. *Mitigation*: render-on-click affordance for non-image binaries; image inline-render gated on size < 512 KB.
- **R-D-4** OSC 1338 is a Quanta-specific extension; other terminals see garbage. *Mitigation*: documented in ADR; OSC 1338 emission gated on `$QUANTA` env presence.

### Files

- **New**: `packages/ui/src/entities/run/output-hints.ts`
- **New**: `packages/ui/src/features/output-hints/detect.ts`
- **New**: `packages/ui/src/features/output-hints/__tests__/detect.test.ts`
- **New**: `packages/ui/src/widgets/block-overlay/hints/TableView.tsx`
- **New**: `packages/ui/src/widgets/block-overlay/hints/ProgressBar.tsx`
- **New**: `packages/ui/src/widgets/block-overlay/hints/JsonTree.tsx`
- **New**: `packages/ui/src/widgets/block-overlay/hints/BinaryPreview.tsx`
- **New**: `packages/ui/src/widgets/block-overlay/hints/__tests__/` (per-widget test files)
- **Update**: `packages/host-tauri/resources/shell-integration/{bash,zsh,fish}` (hint helpers)
- **Update**: `packages/ui/src/shared/lib/vt-emulator/` (OSC 1338 dispatch)

---

## Epic P2-E — Agent tool-call surface

### Goal

Render agent (LLM) tool invocations as Runs with type-discriminated chrome — `Run{kind: 'agent-tool-call', intent, tool, args, result}`. User Runs and agent Runs share the same overlay stack, same scrollback, same search index, same journal. Parity: the user sees "agent ran `ls /tmp`" as a distinguishable block next to their own `ls` — no separate chat surface, no split-context.

### Entry state

- P2-A Run entity supports `kind: 'agent-tool-call'` structurally but no producer emits it.
- P2-B Intent router accepts `source: 'agent'` intents.
- Legacy `features/ai-explain/` + `features/ai-suggest/` operate as separate panels, not as Runs.
- No agent SDK integration; future agent system (Plan 0006+) binds here.

### Exit state

- `features/agent-surface/tool-call-adapter.ts` — accepts an external agent SDK's tool-call event; emits an `Intent{source:'agent', kind:'agent-tool-call'}` into the router; creates a `Run{kind:'agent-tool-call'}` on completion.
- Agent Runs render with distinct chrome (icon, colour accent, tool-call summary line) inside `widgets/block-overlay/`.
- User can scroll up and see interleaved agent + user Runs in chronological order — one surface.
- Tool-call args + result are attached as `OutputHints` (P2-D) — a tool that returns structured data renders as a TableView or JsonTree.
- Rerun / retry affordance — right-click an agent Run to rerun as a user Run with edits.

### Work items

E1. New `packages/ui/src/features/agent-surface/types.ts` — `AgentToolCall = { tool, args, result, reasoning? }`.
E2. New `packages/ui/src/features/agent-surface/tool-call-adapter.ts` — SDK integration point; consumes external events, produces Intents.
E3. Chrome: extend `widgets/block-overlay/BlockOverlay.tsx` to render `kind: 'agent-tool-call'` Runs with distinct styling (accent colour + icon + tool-name label).
E4. Rerun affordance: `features/block/rerun.ts` gains `rerunAsUser(runId)` — lifts an agent Run's `args` into the composer for edit-and-submit.
E5. Safety gate (P2-B B6) applies to agent intents with stricter defaults; `source:'agent'` with `kind:'agent-tool-call'` on a destructive pattern always prompts.
E6. Journal integration: agent Runs persist alongside user Runs in the event journal (P1-E) with the `source` field preserved.
E7. Metrics: `quanta.agent.tool_calls_total{tool}`, `quanta.agent.tool_call_duration_p99_ms{tool}`, `quanta.agent.rerun_as_user_total`.

### Exit gates

- **E-E-01** `features/agent-surface/__tests__/tool-call-adapter.test.ts` — SDK event in → Intent emitted → Run created with correct kind + source.
- **E-E-02** Integration: a mock agent tool call emits a Run that renders in BlockOverlay with distinct styling.
- **E-E-03** Safety-gate: an agent `rm -rf /` attempt is blocked with a banner; non-destructive agent call proceeds.
- **E-E-04** Rerun: right-click on an agent Run opens the composer pre-filled; submitting creates a user Run with `parent = agent-run-id`.
- **E-E-05** Journal roundtrip: agent Runs survive session restore with `source:'agent'` intact.

### Dependencies

- P2-A (Run entity with `kind`).
- P2-B (Intent router + safety middleware).
- P2-D (tool results as structured output hints).

### Effort bucket

**medium** (adapter + chrome + rerun + safety wiring; no new primitives, composes existing epics).

### Risks + mitigations

- **R-E-1** Agent SDK event format instability (assumes an external agent system that Plan 0005 doesn't ship). *Mitigation*: adapter accepts a generic `{tool, args, result}` shape; SDK binding is a separate thin layer.
- **R-E-2** User confusion: "did I run that or did the agent?". *Mitigation*: persistent visual distinction (icon + accent) + `source: 'agent'` label in the command summary.
- **R-E-3** Agent infinite loop creating Runs at 100 Hz floods the surface. *Mitigation*: agent-source Intents throttled to 10 Hz in the router; excess batched.
- **R-E-4** Rerun-as-user race — user edits args, agent Run already exited, rerun picks up a stale parent. *Mitigation*: rerun captures parent by id at rerun time; if agent Run has since been evicted, still create a user Run with no parent link.

### Files

- **New**: `packages/ui/src/features/agent-surface/types.ts`
- **New**: `packages/ui/src/features/agent-surface/tool-call-adapter.ts`
- **New**: `packages/ui/src/features/agent-surface/__tests__/tool-call-adapter.test.ts`
- **New**: `packages/ui/src/features/block/rerun.ts`
- **Update**: `packages/ui/src/widgets/block-overlay/BlockOverlay.tsx` (agent styling)
- **Update**: `packages/ui/src/widgets/block-overlay/block-overlay.module.css` (agent accent)
- **Update**: `packages/ui/src/features/intent/middleware/safety-gate.ts` (stricter agent defaults)

---

## Epic P2-F — Per-run resource usage

### Goal

Attach CPU / memory / network telemetry to every Run, sampled from the sidecar at Run scope (child processes traced from the session's PTY process group). Surfaces as a footer stat in the overlay ("0.3 s CPU, 42 MB peak, 1.2 MB net"); aggregates in a session-level "top"-style panel.

### Entry state

- P2-A Run entity with `Run.resource?: ResourceUsage` field declared structurally but unpopulated.
- Sidecar (Rust) has process-tree awareness via `embedded_shell.rs` + flow_control but no periodic sampling.
- Platform APIs: `getrusage(RUSAGE_CHILDREN)` on Linux / macOS; `/proc/<pid>/status` + `/proc/<pid>/net/dev` on Linux.
- No UI surface for resource metrics.

### Exit state

- `packages/host-tauri/src-tauri/src/resource_sampler.rs` — samples the session's process tree every 500 ms; aggregates under the currently-running Run.
- Run lifecycle: on `running → exited`, final sample + delta committed to `Run.resource`.
- IPC `quanta_run_resource_subscribe(runId)` emits live samples; `quanta_run_resource_final(runId)` returns the committed delta.
- Overlay footer renders CPU + memory + net bars (`widgets/block-overlay/resource-footer/`).
- Session-level panel `widgets/resource-panel/` lists top-N running + recent Runs by resource consumption.
- Graceful degradation on platforms without `/proc` (BSD, some containers) — best-effort via `getrusage`.

### Work items

F1. New `packages/host-tauri/src-tauri/src/resource_sampler.rs` — periodic sampler with process-tree walk (`sysinfo` crate); emits tauri events.
F2. New `packages/ui/src/features/resource-usage/types.ts` — `ResourceUsage = { cpuMs, memPeakKb, memCurrentKb, netBytesIn, netBytesOut, sampledAt }`.
F3. New `packages/ui/src/features/resource-usage/store.ts` — live sample stream + per-Run final commit.
F4. New `widgets/block-overlay/resource-footer/ResourceFooter.tsx` — three compact bars + hover-for-detail.
F5. New `widgets/resource-panel/ResourcePanel.tsx` — session-wide top-N view; sortable.
F6. Graceful fallback: on non-`/proc` platforms, log a one-time banner; `Run.resource` stays `null`; UI hides the footer.
F7. Per-Run-kind sampling cost cap: total sampler overhead < 0.5 % CPU on a 10-Run session.
F8. Privacy: network byte counts are volumes only, never captured contents.

### Exit gates

- **E-F-01** `resource_sampler.rs` Rust tests — sampler accuracy on a synthetic workload ±5 %; process-tree walks correctly across PID recycling.
- **E-F-02** `features/resource-usage/__tests__/store.test.ts` — live stream → final commit transition; sample dedup.
- **E-F-03** Integration: run `yes | head -c 1G` → Run.resource shows cpuMs > 0, memPeakKb > 0, net == 0. Run `curl localhost/big` → netBytesIn > 0.
- **E-F-04** Platform fallback: on BSD or a container without /proc, Run.resource = null; UI hides footer gracefully; no crash.
- **E-F-05** Overhead: sampler running at 2 Hz on 20 Runs adds < 0.5 % CPU on idle system.

### Dependencies

- P2-A (Run.resource field).
- P0 ε (sidecar architecture; resource_sampler reuses embedded_shell.rs process-tree plumbing).

### Effort bucket

**medium** (Rust sampler + 2 UI widgets + platform fallback + overhead tuning).

### Risks + mitigations

- **R-F-1** Process-tree walk misattributes a long-lived background daemon (spawned via `&`) to the Run that started it. *Mitigation*: track process start-time + Run start-time; daemons outliving the Run fall out of attribution.
- **R-F-2** macOS sandboxing blocks `/proc`-equivalent (uses `libproc`). *Mitigation*: platform-specific sampler per Linux / macOS / Windows; `sysinfo` crate abstracts most of it.
- **R-F-3** Sampler overhead visible in perf-budget tests. *Mitigation*: gated behind `flag.runResourceSampling` default off; E-F-05 enforces the overhead cap.
- **R-F-4** Network byte counts collected per-process require elevated capabilities on some Linux distros. *Mitigation*: if unreadable, net fields default to `null`; UI renders CPU + mem only.

### Files

- **New**: `packages/host-tauri/src-tauri/src/resource_sampler.rs`
- **New**: `packages/host-tauri/src-tauri/src/resource_sampler_tests.rs`
- **New**: `packages/ui/src/features/resource-usage/types.ts`
- **New**: `packages/ui/src/features/resource-usage/store.ts`
- **New**: `packages/ui/src/features/resource-usage/__tests__/store.test.ts`
- **New**: `packages/ui/src/widgets/block-overlay/resource-footer/ResourceFooter.tsx`
- **New**: `packages/ui/src/widgets/resource-panel/ResourcePanel.tsx`
- **Update**: `packages/host-tauri/src-tauri/src/ipc.rs` (IPC commands)
- **Update**: `packages/host-tauri/src-tauri/src/lib.rs` (sampler wiring)

---

## Epic P2-G — Replay UX

### Goal

Ship a CLI — `quanta replay <journal-file>` — that mounts an external P1-E journal into a live Quanta surface. Past sessions become reviewable, scrubbable, and searchable as a first-class UI mode alongside live sessions. Every Run in the journal renders as a mounted Run; the user can scrub timeline, jump to a boundary, and (optionally) resume from a point as a live session.

### Entry state

- P1-E event journal persists per-session records; replay engine reconstructs `GridSnapshot` statically.
- No CLI entry point; no external-file mount; no scrub UI.
- Session-restore is reload-only (current session's own journal).
- `features/session-record/recorder.ts` writes asciicast v2 for user-facing recordings — parallel to P1-E's journal format.

### Exit state

- `packages/cli/` (new package) ships `quanta replay <journal-file>` — reads an external journal, boots Tauri in replay mode, mounts journal Runs into a new session tab with a scrubbable timeline.
- `widgets/replay-timeline/` — horizontal timeline at the bottom; drag to scrub; click a Run to jump.
- Timeline plays back at 1× / 2× / 5× / 10× speed; `Shift+Space` pauses.
- At any frame, user can "fork" — open a new live session with cwd + env derived from the journal's last-known state.
- Replay Runs render with a distinct styling (greyscale accent + "replay" label).

### Work items

G1. New `packages/cli/` package — Tauri CLI entry; subcommand `replay <file>`; opens main window with replay-mode flag.
G2. New `packages/ui/src/features/replay-mode/` — mode store; subscribes to journal stream; drives `VtEmulator.feed` at configurable speed.
G3. New `widgets/replay-timeline/ReplayTimeline.tsx` — row of Run markers + scrub handle; boundary ticks sized by Run duration.
G4. Keybindings: `Shift+Space` play/pause; `Shift+Left/Right` skip Run; `Shift+Cmd+F` search within replay.
G5. Fork affordance: `forkAsLive(runId)` spawns a new session tab with cwd derived from the last OSC 7 before `runId`.
G6. Distinct styling: replay Runs carry `source: 'replay'` via P2-B intent field; chrome applies greyscale accent.
G7. Journal-version compat: only v2+ journals (P2-A format) support Run-aware replay; v1 journals fall back to raw-bytes playback (no per-Run navigation).

### Exit gates

- **E-G-01** CLI smoke: `quanta replay fixtures/journals/sample-v2.journal` opens a window with the timeline populated.
- **E-G-02** `features/replay-mode/__tests__/` — 1× / 2× / 10× speed playback produces byte-identical `GridSnapshot` at each checkpoint.
- **E-G-03** Scrub accuracy: dragging timeline to Run N produces grid state matching a fresh playback-to-N.
- **E-G-04** Fork-as-live: forking from a Run with recorded cwd spawns a new session in that cwd; new Runs have no parent.
- **E-G-05** Version compat: a v1 journal opens, plays back without Run markers, with a one-time banner explaining the degraded mode.

### Dependencies

- P2-A (Run entity + journal v2 schema).
- P1-E (journal format + replay engine).
- P1-F (search-within-replay; reuses scrollback-index).

### Effort bucket

**large** (new package + CLI + mode store + timeline widget + keybindings + version-compat path).

### Risks + mitigations

- **R-G-1** Replay determinism — any non-clock-injectable engine code path reintroduces (see P1-E R-E-1). *Mitigation*: replay-mode requires the P1-E clock-injectable invariant; fail fast on detected wall-clock reads in debug mode.
- **R-G-2** CLI adds a Tauri attack surface (arbitrary file read). *Mitigation*: replay file is read via an allowlisted IPC command; no filesystem access beyond journal + cwd.
- **R-G-3** Timeline widget with 10k Runs becomes unresponsive. *Mitigation*: virtualised timeline; render-on-visible-range; Run markers below zoom threshold coalesce.
- **R-G-4** Fork-as-live reconstructs a cwd that doesn't exist anymore. *Mitigation*: fallback to `$HOME` + banner (matches P1-E R-E-4).

### Files

- **New**: `packages/cli/` (new workspace package)
- **New**: `packages/cli/src/replay-subcommand.ts`
- **New**: `packages/ui/src/features/replay-mode/index.ts`
- **New**: `packages/ui/src/features/replay-mode/mode-store.ts`
- **New**: `packages/ui/src/features/replay-mode/__tests__/playback.test.ts`
- **New**: `packages/ui/src/widgets/replay-timeline/ReplayTimeline.tsx`
- **New**: `packages/ui/src/widgets/replay-timeline/__tests__/ReplayTimeline.test.tsx`
- **New**: `packages/ui/src/features/block/fork-as-live.ts`
- **Update**: `packages/host-tauri/src-tauri/src/main.rs` (replay-mode CLI arg)
- **Update**: `packages/ui/src/entities/run/selectors.ts` (`source:'replay'` styling hook)

---

## Cross-cutting concerns

### ADR dependencies

P2 authors or amends the following ADRs:

- **ADR 0023 Run entity** (P2-A) — lifecycle, projection contract, journal schema v2.
- **ADR 0024 Intent router** (P2-B) — middleware protocol, outcome types, safety defaults.
- **ADR 0025 Priority classes** (P2-C) — class definitions, drop ordering, control-lane invariant.
- **ADR 0029 (new) Structured output hints** (P2-D) — OSC 1338 format, fallback policy.
- **ADR 0030 (new) Agent tool-call surface** (P2-E) — Run.kind=agent-tool-call chrome, safety gates, rerun semantics.
- **ADR 0031 (new) Per-run resource sampling** (P2-F) — sampler overhead cap, platform fallback, privacy.
- **ADR 0032 (new) Replay UX** (P2-G) — CLI surface, journal v2 requirement, fork-as-live semantics.

### Flag flips

- `flag.runEntity` (P2-A) — default off in wave-2; default on in wave-3 after projection parity verification.
- `flag.intentRouter` (P2-B) — default off; flip gated on keystroke latency perf hold.
- `flag.priorityBackpressure` (P2-C) — default on by category: `control` lane always on; verbose/scrollback drop paths default off until C-BP-01 green.
- `flag.outputHints` (P2-D) — default on per-kind: table/progress/json default on; binary default off pending image-safety review.
- `flag.agentSurface` (P2-E) — default off; depends on an external agent SDK binding.
- `flag.runResourceSampling` (P2-F) — default off; overhead-cap gated.
- `flag.replayMode` (P2-G) — CLI-entry only; no runtime flag.

### Test strategy additions

- **New compat fixtures**: C-BP-01 (verbose throttle), C-RUN-01 (pipeline parent/child), C-HINT-01 (table render), C-AGENT-01 (agent-as-Run), C-REPLAY-01 (CLI roundtrip).
- **New perf scenarios**: priority-classifier overhead, TableView 10k-row render, resource-sampler overhead, replay-scrub latency.
- **New integration fixtures**: intent-router-middleware-chain, run-projection-parity, replay-timeline-scrub.
- **CI rule additions**: `one-input-path` rule extended to accept router-dispatch as the canonical entry; `no-wall-clock-in-replay` rule enforces P1-E / P2-G determinism invariant.

### Migration from P1 flags

- `flag.blockUx` remains — P2-A projections preserve the P1-C surface.
- `flag.sessionRestore` default-on flip happens **after** P2-A journal v2 migration is dogfood-validated.
- No P1 flag is removed; P2 is purely additive.

---

## Rollout sequence

```
                ┌─────────────┐
                │  P2-A       │   (first; seed lands
                │  Run entity │    in P1 wave-2-D)
                └──────┬──────┘
                       │
                       ▼
                ┌──────────────┐
                │  P2-B        │
                │  Intent      │
                │  layer       │
                └──────┬───────┘
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
       ┌──────────┐         ┌──────────┐
       │ P2-C     │         │ P2-D     │   (parallel after B)
       │ Priority │         │ Structured│
       │ BP       │         │ output   │
       └──────────┘         └────┬─────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
               ┌─────────┐  ┌─────────┐  ┌─────────┐
               │ P2-E    │  │ P2-F    │  │ P2-G    │
               │ Agent   │  │ Resource│  │ Replay  │
               │ surface │  │ usage   │  │ UX      │
               └─────────┘  └─────────┘  └─────────┘
```

Suggested lane:

- **Wave 2 of P1** carries the P2-A seed (new `entities/run/` scaffolding, wire `Block` to projection).
- **Wave 3** completes P2-A + ships P2-B (both are foundational; nothing downstream starts without them).
- **Wave 4** parallelises P2-C + P2-D.
- **Wave 5** parallelises P2-E + P2-F + P2-G.

Total budget (effort buckets): large × 4 (A, B, D, G) + medium × 3 (C, E, F). No calendar.

---

## Done definition (P2 ship gates)

Mirrors P0 / P1's 12-gate structure. All must be green to declare P2 shipped.

1. **Run entity is the canonical unit** — `Block` is a projection; `entities/run/` store is source of truth.
2. **Intent router is the single byte path** — keystrokes, composer, agent SDK all dispatch via `features/intent/router.ts`.
3. **Priority-classified drop policy live** — `dropped_control === 0` invariant holds across a 24 h dogfood.
4. **Structured output hints render for table / progress / json-stream / binary** — producer + consumer shipped; plain-text fallback verified.
5. **Agent Runs render alongside user Runs with parity** — same overlay, same search, same journal.
6. **Per-Run CPU + mem + net sampled** on supported platforms; overhead < 0.5 % on idle.
7. **Replay CLI mounts external journals** with scrub + fork-as-live.
8. **Journal schema v2 migrates v1 cleanly** — zero data loss across version boundary.
9. **All P2 ADRs (0023, 0024, 0025, 0029–0032) landed** and referenced in README.
10. **P2 epics green in SHIP_SIGNOFF.md** (P1-I rule-set extended per epic).
11. **Perf regression gate active on P2 surfaces** — priority classifier, TableView, resource sampler, replay playback all baseline-tracked.
12. **No regression in P0 / P1 invariants** — CI grep rules still strict-clean; P0 compat matrix + P1 done-definition gates remain green.

Until all twelve hold, P2 does not ship.

---

## Non-goals

Explicitly parked beyond P2:

- **Agent SDK itself** — P2-E binds to an external agent system; the agent's own scheduling / tool registry / prompt management belongs to a separate plan line (Plan 0006+).
- **Collaborative multi-user terminals** — Run sharing, live cursor collab. Out of scope.
- **Mobile / iPad ports** — terminal-as-execution-surface is desktop-first.
- **WebGL migration** (Plan 0002) — render backend is orthogonal; P2 epics compose with either backend.
- **Plugin-authored Run kinds** — Plan 0004 (plugin system) may later expose Run.kind as an extension point; not a P2 gate.

Also out of scope for P2:

- **Distributed session restore** — cross-device replay is a Plan 0005+ follow-up.
- **ML-driven output classification** — heuristics only for `json-stream` / `progress` / verbose detection. No in-process ML.
- **Per-Run quotas / kill-on-overrun** — resource sampling is observational only; enforcement is out of scope (lives in OS-level cgroups if ever).

---

## Glossary (delta over p1-roadmap §"Glossary")

- **Run** — first-class lifecycle record for any execution (user command, agent tool call, pipeline stage, replay frame). Carries id, kind, state, rowRange, intent, resource, parent / children.
- **Intent** — typed action record dispatched through the router before bytes reach the PTY. Kinds: `keystroke`, `submit-command`, `agent-tool-call`, `paste`, `signal`.
- **Priority class** — one of `control` / `visible` / `scrollback` / `verbose`; determines drop ordering under sustained backpressure.
- **Output hint** — structural metadata attached to a Run's output range (`table`, `progress`, `json-stream`, `binary`) that lets chrome render typed affordances.
- **Agent Run** — a Run with `kind: 'agent-tool-call'` and `source: 'agent'`; renders with distinct chrome.
- **Replay Run** — a Run with `source: 'replay'`; produced by mounting an external journal via `quanta replay`.
- **Fork-as-live** — scrub to a journal frame, spawn a fresh live session derived from that frame's cwd + env.
- **Projection** — a derived view over `Run` (e.g. `Block`, `PipelineSummary`) that stays stable across underlying entity changes.
