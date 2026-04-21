# Plan 0005 — P1 wave 2 gap audit

- **Status**: draft (2026-04-21)
- **Entry commit**: post-wave-1 (9 P1 agents merged)
- **Author**: integration auditor
- **Scope**: identify what wave 1 landed, what is flag-gated, what is
  default-on, and what still needs wave-2 wiring before P1 can ship.

## Executive summary

P1 wave 1 landed the **primitives and inner plumbing** for all seven P1 epics
(A, B, C, D, E, F, G) plus H/I infrastructure. The wave is surprisingly
well-integrated for A/B/C (hybrid detector → boundary listener → block store
→ overlay is fully wired behind `flag.blockUx`). Wave 2 is almost entirely
about **host-layer wiring** (Tauri journal port, settings UI), **default-flip
of feature flags**, and **the two epics whose drivers were built but never
consumed** (D mode-stack, G ghost hints).

Flake rate across 3 full UI suite runs: **0.0%** (363 files, 4956 tests,
identical pass counts).

---

## 1. Test / flake audit (evidence)

| Run | Test files | Tests | Skipped | Duration |
|-----|-----------|-------|---------|----------|
| 1   | 363 ✓     | 4956 ✓ | 16      | 43.55s   |
| 2   | 363 ✓     | 4956 ✓ | 16      | 35.56s   |
| 3   | 363 ✓     | 4956 ✓ | 16      | 36.74s   |

- Flake rate: 0/3 runs flaked. **0.0%**.
- Compat suite: 34 files / 79 tests ✓ (single run; matches wave-1 baseline
  of 91+ P0 compat tests when combined with fixture harness).
- New integration file `p1-wave1-integration.test.tsx`: 11/11 ✓, 50 ms.

### CI grep rules (strict/warn/DEFER)

| Rule | Mode | Warnings |
|------|------|----------|
| `check:render-path`      | ok with **2 deferred warn** | `BlockCard.tsx:62`, `ComparePanel.tsx:48` (ansi-parser imports) |
| `check:input-path`       | ok with **2 deferred warn** | `execute.ts:136`, `execute.ts:183` (`bridge.write` in submit path) |
| `check:no-block-chunks`  | ok (warn-only)              | 0 hits                           |
| `check:signoff`          | — (see SHIP_SIGNOFF grid)   | 2 RED (gates 9, 12), 1 DEFERRED (gate 5) |

**No rule is regressing**. Deferred warnings are carry-overs from P0 wave 4
and are expected to clear in wave-2 W2-B/C once the overlay grid-read path
replaces the ansi-parser imports and the composer submit path finishes its
Epic δ migration.

---

## 2. P1 epic wiring matrix

| Epic | Flag | Wave-1 delivered | Prod wired? | Default | W2 owner |
|------|------|------------------|-------------|---------|----------|
| **P1-A** Hybrid boundary detector | `blockUx` | Full detector + suppression + OSC 133 parser + 4 tiers | **Yes** (connect.ts:374, `installCommandRouter({ hybrid })` when `blockUx` + !mockBridge) | Off — gated on `blockUx` | W2-B (flag flip) |
| **P1-B** Shell-integration auto-install | `shellIntegrationAutoInstall` | `maybeAutoInstallShellIntegration` helper + back-off + toast + shell family | **Yes** (connect.ts:405, fire-and-forget on every spawn) | **On** by default | None — ships live |
| **P1-C** Block overlay chrome | `blockUx` | `BlockOverlayHost`, `BlockOverlay`, `EvictionBanner`, row-range tracker, pin lifecycle, grid-read `BlockCard` | **Yes** (TerminalPage.tsx:1028, `blockUxOn && !altScreen.active`) | Off — gated on `blockUx` | W2-B (flag flip) |
| **P1-D** Mode stack + drivers | none | Full store + 5 drivers (alt-screen, multiplexer, pager, repl, nested-shell) + policy resolvers | **NO** — drivers are never instantiated outside tests; `GhostHint` uses a stub shim `widgets/ghost-hint/useModeStack.ts` that returns empty layers | Off — unused | **W2-C** (wire drivers into session engine) |
| **P1-E** Session restore (replay) | `sessionRestore` | `.qrpl` format reader, `replaySession` + storm limits + privacy hooks | **Partial**: `TerminalPage.tsx:469` calls `replaySession` when flag on, but supplies a **no-op port** (`loadSessionJournal: async () => []`); `createTauriJournalPort` is exported but never invoked by any host package | Off — `sessionRestore === false` default | **W2-D** (Tauri IPC `quanta_session_journal_read` + pass port into page) |
| **P1-F** Output search (scrollback) | `blockUx` (via TerminalPage mount) | `searchGrid` + `searchGridResult`, time-budget + ReDoS guard, viewport+scrollback walker | **Yes** (`FindPanel.tsx:112`, TerminalPage.tsx:1057 `<OutputSearch />`), Cmd+F bound | Live when terminal page renders; the panel is transient (opens on keystroke) | None — ships live |
| **P1-G** Ghost hints | none | `GhostHint` widget + registry; CSS; tests | **Partial**: widget mounts, but its `useModeStack()` hook is a **local shim** returning empty `layers[]`. Real mode stack is not wired → widget always renders null in prod | On — harmless no-op | **W2-E** (swap shim for `features/mode-stack/useModeStack`) |
| **P1-H** Perf live in CI | — | Scaffolding in tools | See SHIP_SIGNOFF gate 7 GREEN; gate 12 RED | Infra | W2-F (baseline comparator) |
| **P1-I** Sign-off automation | — | `tools/ship-signoff-gen` + `pnpm check:signoff` | Yes; runs today, 2 gates RED | Infra | W2-G (close gates 9/12) |

---

## 3. Cross-agent mismatches / integration gaps

### Gap 3.1 — Mode stack is built but not fed (P1-D)

**Symptom**: `features/mode-stack` exports a full driver set
(`createAltScreenDriver`, `createMultiplexerDriver`, `createPagerDriver`,
`createReplDriver`, `createNestedShellDriver`) and a zustand `ModeStack`
store with push/pop/policy resolvers. A grep across `packages/` shows zero
production consumers: drivers are imported only by their own `__tests__/`.
The shell layer is seeded on construction but no production byte stream is
ever fed into `driver.feed(...)`.

**Consequence**:

- `useModeStackStore.getState().layers` is always `[{ kind: 'shell' }]` in
  prod.
- `GhostHint` (P1-G) reads from a local shim (`widgets/ghost-hint/useModeStack.ts`)
  that **always returns an empty layers array** — the hint never appears.
- Mouse arbitration at depth ≥ 2 (`P1 ship gate 6`) has no implementation;
  alt-screen is still tracked via the separate `entities/tui` store.
- Compat fixture `C-MUX-03 tmux-in-ssh-in-tmux` renders bytes but does NOT
  assert `modeStack.depth === 3`. Integration test
  `test_p1_mode_stack_depth_3` now covers the driver composition directly;
  wiring it to a real session remains W2-C's responsibility.

**Fix (wave 2, W2-C)**:

1. In `features/session/connect.ts`, instantiate the five drivers keyed on
   `sessionId`.
2. Forward the engine's pre-batcher byte stream (or a post-emulator
   envelope-synchronous hook) into each driver's `feed`.
3. Dispose on session close.
4. Swap `widgets/ghost-hint/useModeStack.ts` to re-export from
   `features/mode-stack/mode-stack-store.ts`.
5. Add driver byte-cost micro-bench (should be < 50 µs / MiB per driver;
   five drivers × 4 MiB/s worst case ≈ 1 ms/s UI budget).

### Gap 3.2 — Session restore is wired to a no-op port (P1-E)

**Symptom**: `TerminalPage.tsx:469` calls
`replaySession(lastId, { port: { loadSessionJournal: async () => [] } })`.
The comment documents the stub explicitly:

> We do NOT construct a Tauri-backed port here — that happens in a
> host-specific wiring layer.

`createTauriJournalPort` is exported from
`features/session-restore/journal-port.ts` and is unused anywhere else.
`packages/host-tauri/src-tauri/src/session_record.rs` is the writer; no
Tauri command `quanta_session_journal_read` exists on the Rust side
(checked via grep — zero hits).

**Consequence**:

- Flag `sessionRestore` can be flipped on and the UI renders the restore
  overlay, but every load returns `fallbackReason: 'no_journal'` and the
  session ships fresh.
- Ship gate 7 ("session restore byte-identical roundtrip") is **not
  demonstrable** end-to-end.
- Integration test `test_p1_session_restore_roundtrip` exercises the
  replay *engine* with a synthesized one-frame journal buffer and
  correctly shows `playedBytes === 7`. The gap is purely the port
  plumbing.

**Fix (wave 2, W2-D)**:

1. Rust: add `quanta_session_journal_read` command in
   `packages/host-tauri/src-tauri/src/ipc.rs` that reads the rotated
   `.qrpl` files for a session id and returns them base64-wrapped.
2. TS: in the Tauri bridge wiring (not the TerminalPage itself — the page
   stays host-agnostic), construct a real port via
   `createTauriJournalPort(invoke)` and pass it into `replaySession`.
3. Add an integration test that records a session, shuts down, reopens,
   and asserts grid hash equality.
4. Document in ADR 0027 the privacy knobs (secret redaction) flowing
   through the journal writer.

### Gap 3.3 — Ghost hint widget has a local mode-stack shim (P1-G)

**Symptom**: `widgets/ghost-hint/useModeStack.ts` (57 lines) says:

> Once P1-D lands, replace the body with the real store selector:
>
> ```ts
> return useModeStackStore((s) => ({ layers: s.layers }));
> ```

This was correct language at wave-1 time. P1-D is now merged (the driver
set is live). The swap has not happened.

**Consequence**: the hint widget is mounted, but `layers: []` means no
hint kind ever resolves → widget returns null every frame in prod.

**Fix (wave 2, W2-E)**:

Delete the shim; re-export the real `useModeStack` from
`features/mode-stack/index.ts`. One-line swap once 3.1 is done.

### Gap 3.4 — Session feature imports land via `features/session/shell-install.ts`, not the documented `features/shell-integration-wizard/*` slice

**Symptom**: P1-B's roadmap prescribes
`packages/ui/src/features/shell-integration-wizard/detect-shell.ts` +
`auto-install.ts`. Wave 1 delivered the functionality under
`packages/ui/src/features/session/shell-install.ts` instead. The wizard
subtree (`features/shell-integration-wizard/`) still exists with a separate
`install.ts` + `detect.ts` that serve the manual wizard.

**Severity**: low. The two paths don't conflict — `maybeAutoInstallShellIntegration`
has its own flag gate, back-off, and toast. The wizard path is a manual
retry surface. The naming divergence is purely a file-location mismatch
vs the roadmap.

**Fix (wave 2, optional, W2-H)**: consolidate under
`features/shell-integration-wizard/` if and when the wizard itself gets
a refactor; otherwise, update `p1-roadmap.md` to document the delivered
layout.

### Gap 3.5 — Feature flag names do not match the roadmap

**Symptom**:

| Roadmap name                              | Delivered key                   |
|-------------------------------------------|---------------------------------|
| `flag.autoInstallShellIntegration`        | `shellIntegrationAutoInstall`   |
| `flag.sessionRestore`                     | `sessionRestore` ✓              |
| `flag.ghostHints`                         | — (no flag delivered; hints off by shim) |

**Severity**: low. Call sites match the delivered names. `ghostHints` is
effectively off because of gap 3.3 rather than a flag.

**Fix**: when 3.3 lands, add `ghostHints` boolean to `feature-flags.ts`
default-on per roadmap §"Migration from P0 flags".

### Gap 3.6 — OSC 133 hit rate gate still DEFERRED (ship gate 5)

**Symptom**: `pnpm check:signoff` shows gate 5 ("OSC 133 boundary ≥ 99 %")
as **DEFERRED**. Wave-1 built the hybrid detector and wired it in, but
no compat fixture asserts the 99 % hit rate over a 50-command corpus
(roadmap E-A-02 `C-BD-01`, E-A-03 `C-BD-02`).

**Fix (wave 2, W2-I)**: land the two compat fixtures. Existing
`C-MUX-*`, `C-PG-*`, `C-RP-*` harnesses in
`packages/ui/src/__tests__/compat/` show the shape.

### Gap 3.7 — Preamble block lives in connect.ts, not the detector path (minor)

**Symptom**: `connect.ts:321` starts a preamble block with empty command
BEFORE the hybrid detector's boundary listener sees any bytes. When the
first real OSC 133 A arrives, the listener calls `completeBlock` on the
*previous* active block (the preamble) and starts a second block. This
works (and is the intended behavior per the hybrid listener docstring),
but it means two blocks are always created per session: one preamble
(synthetic), one real.

**Severity**: minor — cosmetic only. The preamble is hidden when command
is empty. But the behaviour is under-tested: `test_p1_stack_basic_end_to_end`
only exercises a single prompt cycle through the detector+listener pair
and does not boot through `connectSession`.

**Fix (wave 2 optional, W2-J)**: add an e2e test that runs
`connectSession` + real hybrid detector events and pins the preamble →
real-block transition.

---

## 4. Recommended wave 2 completion order

1. **W2-C — Mode stack wiring** (gap 3.1). Unblocks 3.3. Size: medium.
   Enables ship gate 6.
2. **W2-E — Ghost hint mode-stack swap** (gap 3.3). One-line after 3.1.
   Size: XS.
3. **W2-D — Session restore Tauri port** (gap 3.2). Independent of 3.1.
   Size: medium (Rust cmd + TS bridge + test fixtures). Enables ship
   gate 7.
4. **W2-I — Compat fixtures for OSC 133 hit rate** (gap 3.6). Size: small
   per fixture (the compat harness is well-established). Enables ship
   gate 5.
5. **W2-B — `flag.blockUx` default flip** (final step). Requires 3.1 +
   3.6 to prove the block UX is safe to default-on. Size: XS; gated on
   the preceding waves. Enables ship gates 1, 8 by construction.
6. **W2-F — Perf baseline comparator** (P1-H). Can run in parallel with
   any of the above. Size: small.
7. **W2-G — Close SHIP_SIGNOFF gates 9 + 12** (P1-I) — DEC 1049/1047/47
   tests (gate 9), KR IME byte-identical (gate 12). Independent of
   everything above.
8. **W2-H, W2-J** — Cosmetic cleanup (gaps 3.4, 3.7). Can wait until post-
   ship.

---

## 5. Test artifacts

- New integration test:
  `packages/ui/src/__tests__/integration/p1-wave1-integration.test.tsx`
  — 11 tests, 50 ms total, all ✓.
- Scenarios covered:
  - `test_p1_stack_basic_end_to_end` — OSC 133 A/B/C/D cycle through
    detector + listener + pin API + store mutations.
  - confidence taxonomy mapping sanity (`mapSourceToConfidence`).
  - `test_p1_session_restore_roundtrip` — empty-port `no_journal`
    fallback plus a one-frame `.qrpl` byte-path roundtrip.
  - `test_p1_mode_stack_depth_3` — outer-tmux × ssh × inner-tmux driver
    composition; nested shell depth counter; alt-screen + tmux driver
    co-existence.
  - `test_p1_output_search_across_scrollback` — 1000-row scrollback
    literal search; case-insensitive variant.
  - `test_p1_shell_install_back_off` — 3-strike threshold + 24 h lockout
    boundary cases.
  - Cross-epic sanity: heuristic detector tier produces a heuristic-
    confidence block when OSC 133 is absent.

All 11 pass against the current main tree. None required modifying P1
wave 1 code.
