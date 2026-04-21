# Plan 0005 P1 Roadmap

- **Status**: **wave 1 landed (2026-04-22)** — all 9 epics spine-delivered at `868e482`; wave 2 is polish + integration close-out.
- **Entry commit**: `fab7198` (P0 ship-to-staging, supersedes `f74c047`).
- **Wave 1 commit**: `868e482` — 98 files, +14818 / −53 lines; UI suite 4956 / 4972 green.
- **P0 status**: 11 / 12 ship gates GREEN at `fab7198`; gate 7 (perf green-at-budget) carried into P1-H polish.
- **Authors**: Engine team
- **Reads-from**: [README.md §6](./README.md#6-p1--block-ux--integration-authority-after-p0-green), [gap-tracking.md](./gap-tracking.md), [test-strategy.md](./test-strategy.md), [p2-roadmap.md](./p2-roadmap.md)

---

## Wave 1 landing snapshot

Every epic below carries a per-epic "wave 1 status" marker taken at commit `868e482`:

- `landed (wave 1)` — spine is shipped; the epic is functional in the tree under its feature flag.
- `polish pending (wave 2)` — spine landed; specific work items (ADRs, tests, UX refinements) remain for wave 2.
- `integration pending (wave 2)` — spine landed but has explicit gating (e.g. field still lives on the type, flag default off, CI rule not yet strict).

See `gap-tracking.md` "P1 wave 1 landed" section for the consolidated file / test / delta breakdown.

---

## Overview

P0 rebuilt Quanta into an **xterm-replaceable terminal**: one `VtEmulator` per session, one `SessionInputSurface` input path, one cell-renderer render path, a bounded scrollback ring with a reserved pin hook, and a 30-row compat matrix on macOS + Linux. The default UI is a plain grid fed through the engine. Block chrome, OSC 133 authority, auto-installed shell integration, session restore, and cross-scrollback search are all **absent by design** in P0 — the `flag.blockUx` zustand store defaults to `false` and unmounts the entire legacy presentation layer.

P1 lifts the terminal into a **Warp-replaceable block surface**: a hybrid boundary detector that fuses OSC 133 authority with a heuristic fallback and an idle backstop; opt-out shell-integration auto-install with a failure banner; an absolute-overlay block chrome that does not touch the byte path; a mode-stack polish pass for pager/tmux/REPL affordances; replay-of-events session restore; scrollback-wide output search; and pager/REPL ghost hints. Every epic is independently flag-gated on top of `flag.blockUx` so dogfooders can opt into block UX without opting into, e.g., REPL hints.

Execution-surface concerns — the Run entity, the Intent layer, priority-classified backpressure, the agent surface — remain **P2**, not P1. P1's mandate is to make block UX the default **presentation** over a working terminal; it must not regress the P0 byte path, the P0 invariants (I-11 one render, I-12 one input, I-14 scrollback bounded), or the P0 perf budgets. Any P1 work that would require a byte-path change is escalated; any P1 work that would require a new Run / Intent / priority-class concept is deferred to P2.

Rollout is sequenced: A and B ship parallel (both dependency-free on the P0 payload), C depends on A and B, D and F depend on C, E depends on C, G depends on D. Two bonus epics — P1-H (Perf-live-in-CI) and P1-I (Sign-off automation) — close infrastructure gaps the P0 wave left partially scaffolded.

---

## Epic P1-A — Hybrid boundary detector

**Wave 1 status**: `landed (wave 1)` + `polish pending (wave 2)`.
- Spine: `features/command/hybrid-detector.ts` (745 LOC) fuses OSC 133 (conf 1.0) + prompt-regex heuristic (0.6–0.8) + cursor-home pattern (0.5) + idle timeout (0.1) with arbitration window + telemetry, wired into `route-output.ts`. 65 tests across 4 files.
- Wave-2 polish: ADR 0021 authoring (below §"Files"); compat fixtures `C-BD-01` / `C-BD-02` (E-A-02 / E-A-03 exit gates); `osc-subscribe.ts` (A7) was folded inline, to be extracted as a first-class emitter surface when P1-E journal replay consumes OSC events.

### Goal
Replace the P0 null-detector with a confidence-stamped detector that fuses OSC 133 primary, prompt-regex / cursor-home heuristic secondary, and an idle-timer tertiary backstop, exposing per-boundary confidence so downstream chrome can render "authoritative" vs "best-effort" differently.

### Entry state
- `features/command/boundary-detector.ts` ships a `BoundaryDetector` port + `createMockBoundaryDetector` that terminator-matches `MOCK_PROMPT_BYTES`. Stateful carry for cross-chunk terminators.
- `features/tui/detect.ts` runs a byte-level alt-screen FSM (DEC 1049/1047/47). Reusable as a parser skeleton.
- `VtEmulator` emits `ModeChanged` events; scrollback ring exposes `_debugPinScrollbackRow(index)` and a `pinBlockedEvictions` counter (types.ts line 144, VtEmulator.ts line 1542).
- `route-output.ts` is dormant under `flag.blockUx === false`.
- OSC 7 / 133 / 1337 are parsed by the Rust VT crate; TS `VtEmulator` mirrors via `ModeEvent`/`OscEvent`. Not yet routed to the boundary detector.

### Exit state
- `HybridBoundaryDetector` implements the `BoundaryDetector` port and is default-injected when `flag.blockUx === true`.
- Each `BoundaryFeedResult` carries `confidence: 'authoritative' | 'heuristic' | 'idle' | 'synthetic'` and an optional `exitCode` (from OSC 133 D, else `null`).
- The detector exposes `mode: 'osc133' | 'heuristic' | 'idle' | 'degraded'` to `features/session/engine.ts`.
- Boundaries produced by any tier pin the covered scrollback row range via `scrollback.pinRow(range)` until the block card is captured or the user scrolls past.
- A CI metric `quanta.boundary.osc133_hit_rate` is emitted and asserted in dogfood sessions.

### Work items
A1. Promote `BoundaryFeedResult` in `packages/ui/src/features/command/boundary-detector.ts` to carry `confidence` and `exitCode`; add a `mode` readback getter. Update existing mock to return `'synthetic'` confidence.
A2. New `packages/ui/src/features/command/osc133-detector.ts` — reads OSC events emitted by `VtEmulator` (new subscription surface) and produces authoritative boundaries on `OSC 133 D`. Handles OSC 133 A/B/C state machine (prompt-start → command-start → command-end → command-done).
A3. New `packages/ui/src/features/command/heuristic-detector.ts` — tracks the last cursor-row write; on `\r` + cursor-home + prompt-regex match (shell-specific patterns under `resources/prompt-regex/{bash,zsh,fish,nushell,ion}.json`), emits a `'heuristic'` boundary. Uses `shared/lib/shell-tokenize/` prompt shape data.
A4. New `packages/ui/src/features/command/idle-detector.ts` — 800 ms cursor-idle AND grid-quiescent (no DamageSet flushes for 800 ms) → emit `'idle'` boundary with `exitCode=null`. Idle timer resets on any `VtEmulator.feed` that produces damage.
A5. New `packages/ui/src/features/command/hybrid-detector.ts` — composes the three above. Priority: authoritative > heuristic > idle. Authoritative arrival within 2 s after a heuristic boundary on the same row range **retracts** the heuristic boundary (downstream chrome must re-stamp confidence).
A6. Wire `HybridBoundaryDetector` into `packages/ui/src/features/session/engine.ts` — replaces the null-detector when `flag.blockUx === true`. Exposes a `getDetectorMode()` readback for the degraded-mode banner.
A7. New `packages/ui/src/shared/lib/vt-emulator/osc-subscribe.ts` — promotes OSC events from debug-only to a first-class emitter surface on `VtEmulator`, consumed by A2. Minimal: OSC 7 (cwd), OSC 133 A/B/C/D, OSC 1337. No new parser.
A8. Promote scrollback pin API from `_debugPinScrollbackRow(index)` to a supported `emulator.pinRows({ startId, endId })` / `unpinRows(...)` pair. Boundary detector owns pin lifecycle; BlockCard mount does not pin independently. Updates `VtEmulator.ts` line 388 and `types.ts` line 144.
A9. Instrumentation: emit `quanta.boundary.confidence_total{tier}`, `quanta.boundary.osc133_retracted_heuristic_total`, `quanta.boundary.idle_timeout_total`. Hooked into existing metrics plumbing (README.md §10).
A10. Byte-accounting: hybrid detector never owns bytes — it only observes. PRE-boundary bytes flow through on the old port. Assert `input_bytes = feed_bytes` holds under all three tiers.

### Exit gates
- **E-A-01** `packages/ui/src/features/command/__tests__/hybrid-detector.test.ts` (new): 30 scenarios — pure OSC 133, pure heuristic, pure idle, heuristic-then-OSC-retraction, degraded-mode fallthrough. ≥ 95% branch coverage.
- **E-A-02** `packages/ui/src/__tests__/compat/C-BD-01-osc133-authority.test.ts` (new compat fixture): zsh + shell integration → `osc133_hit_rate ≥ 99%` over a 50-command corpus.
- **E-A-03** `packages/ui/src/__tests__/compat/C-BD-02-no-integration.test.ts` (new): bash without rc edits → heuristic produces ≥ 90% correct boundaries on a 50-command corpus (false-positive rate < 2%).
- **E-A-04** Scrollback pin test: during block execution the row range containing command output is `pinBlockedEvictions > 0` observable; after boundary + capture, eviction resumes.
- **E-A-05** Byte-accounting retained: `input_bytes_total == feed_bytes_total` across all three tiers.

### Dependencies
- None on other P1 epics (foundation).
- Requires P0 α3 scrollback pin hook (landed, `pinBlockedEvictions` in types.ts).
- Requires P0 α2 OSC emitter surface on `VtEmulator` — exists today at parser level; A7 promotes to public.

### Effort bucket
**medium** (3 detectors + composition + promotion work + compat fixtures).

### Risks + mitigations
- **R-A-1** Heuristic false-positives on prompts that contain user-generated `$` (e.g. rendered git log `-p` patch output matches zsh default prompt shape). *Mitigation*: require OSC 133 on the dogfood channel; heuristic degrades to "most recent prompt-regex-match preceded by a cursor-home sequence," which patch output never satisfies (patch never emits cursor-home).
- **R-A-2** Idle backstop fires during long-running commands that legitimately pause output (e.g. `read -t`, interactive `gcloud auth login`). *Mitigation*: idle tier is only active when the detector has seen NO prompt-regex candidate in the last 30 s — protects interactive flows from the backstop.
- **R-A-3** OSC-retracts-heuristic may produce UI flicker if chrome has already mounted. *Mitigation*: chrome treats `'heuristic'` as a pending state with a subtle style; retraction is a confidence upgrade, not a re-mount.
- **R-A-4** Cross-chunk CSI straddling mis-identifies a cursor-home. *Mitigation*: reuse `features/tui/detect.ts` FSM carry logic; new tests in `__tests__/heuristic-detector-chunk-straddle.test.ts` cover 20 boundary cases.

### Files
- **New**: `packages/ui/src/features/command/osc133-detector.ts`
- **New**: `packages/ui/src/features/command/heuristic-detector.ts`
- **New**: `packages/ui/src/features/command/idle-detector.ts`
- **New**: `packages/ui/src/features/command/hybrid-detector.ts`
- **New**: `packages/ui/src/shared/lib/vt-emulator/osc-subscribe.ts`
- **New**: `packages/host-tauri/resources/prompt-regex/{bash,zsh,fish}.json`
- **New**: `packages/ui/src/features/command/__tests__/hybrid-detector.test.ts`
- **New**: `packages/ui/src/__tests__/compat/C-BD-01-osc133-authority.test.ts`
- **New**: `packages/ui/src/__tests__/compat/C-BD-02-no-integration.test.ts`
- **Rewrite**: `packages/ui/src/features/command/boundary-detector.ts` (extend `BoundaryFeedResult`; keep port stable)
- **Update**: `packages/ui/src/features/session/engine.ts` (inject hybrid when flag on)
- **Update**: `packages/ui/src/shared/lib/vt-emulator/VtEmulator.ts` (pin API promotion at lines 388, 557, 1542–1566)
- **Update**: `packages/ui/src/shared/lib/vt-emulator/types.ts` (line 144 pin type expansion)
- **Update**: `docs/adr/` — author **ADR 0021 Hybrid boundary detector** (deferred from P0 §11).

---

## Epic P1-B — Shell integration auto-install

**Wave 1 status**: `landed (wave 1)` + `integration pending (wave 2)`.
- Spine: `packages/host-tauri/src-tauri/src/shell_install.rs` (500+ LOC) + TS orchestrator `features/session/shell-install.ts` behind `flag.shellIntegrationAutoInstall` default `true`; Tauri IPC `quanta_shell_install_auto` / `quanta_shell_install_status`; 3-strike / 24 h back-off keyed by shell family. 13 Rust + 20 TS tests.
- Wave-2 integration: `uninstall_shell_integration` IPC (B8); banner "Quanta modified `~/.zshrc`" with "Undo" action surfacing via `ShellIntegrationBanner.tsx`; ADR 0022 authoring; telemetry names finalised with the sign-off generator (B9 names match `tools/ship-signoff-gen/gates.mjs` expectations).

### Goal
Ship shell-integration scripts opt-OUT by default: detect the user's login shell on first session, append the appropriate snippet to the rc file, surface a banner on any install failure (permission denied, unknown shell, rc file missing), and honor an explicit opt-out key.

### Entry state
- `packages/host-tauri/resources/shell-integration/{bash.sh,zsh.zsh,fish.fish}` ship OSC 133 A/B/C/D + OSC 7/1337 emitters.
- `packages/ui/src/features/shell-integration-wizard/install.ts` exposes `preview(shell)` and `install(shell, userConfirmed)` against the host bridge.
- `widgets/shell-integration-banner/ShellIntegrationBanner.tsx` is the failure/prompt surface.
- Host bridge `installShellIntegration({shell, confirm})` is live; backed by `packages/host-tauri/src-tauri/src/ipc.rs` (the bridge indirection already validates safely).
- Detection of user's login shell is currently manual (user picks in the wizard dropdown).

### Exit state
- First session spawn triggers an **auto-preview** flow that runs `detect → preview → install` without user interaction when all three of {shell recognized, rc file writable, no prior guard markers} hold.
- Opt-out honored via settings `shellIntegration.autoInstall: false` OR an environment variable `QUANTA_NO_AUTOINSTALL=1`.
- Install failures surface a persistent banner with an "Install manually" button that opens the existing wizard.
- Auto-install is idempotent: re-running on a file with guard markers is a no-op with a debug log.

### Work items
B1. New `packages/ui/src/features/shell-integration-wizard/detect-shell.ts` — reads `process.env.SHELL` via host bridge `readEnv('SHELL')`, falls back to `getent passwd $USER` parse (already in `features/session/` path). Returns `{kind: ShellKind, rcPath: string}` or `{kind: 'unknown'}`.
B2. New `packages/ui/src/features/shell-integration-wizard/auto-install.ts` — orchestrates `detect-shell` → `preview` → `install(shell, userConfirmed=true)` only when `shellIntegration.autoInstall !== false` and guard markers absent. Returns `{status: 'installed' | 'skipped' | 'failed', reason?: string}`.
B3. Wire `auto-install` into `packages/ui/src/features/session/engine.ts` first-session bootstrap. Runs once per app install (persisted marker `quanta:auto-install-attempted` in localStorage); explicit re-run available from settings.
B4. Settings panel key: add `shellIntegration.autoInstall: boolean` to settings schema; default `true`. Wire read/write in `packages/ui/src/widgets/settings-panel/`.
B5. Env flag `QUANTA_NO_AUTOINSTALL=1` honored at bootstrap — overrides the settings value so CI / privileged-env users can disable without touching the settings file.
B6. Failure banner: extend `widgets/shell-integration-banner/ShellIntegrationBanner.tsx` to render `{kind: 'auto-install-failed', reason: string}` with a "Retry" + "Dismiss" + "Open wizard" action triad.
B7. Host-side sentinel: `packages/host-tauri/src-tauri/src/ipc.rs` `install_shell_integration` already checks for guard header; extend to **refuse** installation on a file that lacks `#!/` or a shell-shebang on bash/zsh (fish is exempt — config.fish rarely has one). Logs `refused_reason` in the reply.
B8. Rollback surface: `packages/host-tauri/src-tauri/src/ipc.rs` add `uninstall_shell_integration({shell, confirm})` that strips guard-bracketed lines. Wizard + command palette entry to trigger.
B9. Telemetry: `quanta.shell_integration.auto_install_attempted_total`, `quanta.shell_integration.auto_install_success_total`, `quanta.shell_integration.auto_install_failed_total{reason}`.
B10. Dogfood log surface: on failure, print a single line to the terminal session itself (not the UI banner) — `[quanta] shell integration auto-install skipped: <reason> (run \`quanta install-integration\` to retry)`.

### Exit gates
- **E-B-01** `packages/ui/src/features/shell-integration-wizard/__tests__/auto-install.test.ts` (new): 12 scenarios — fresh install success path × bash/zsh/fish, already-installed no-op, permission denied, unknown shell, opt-out honored, env override honored.
- **E-B-02** `packages/ui/src/features/shell-integration-wizard/__tests__/detect-shell.test.ts` (new): 8 scenarios — SHELL env set, SHELL unset with getent fallback, both unavailable.
- **E-B-03** E2E in `packages/ui/src/__tests__/integration/auto-install-bootstrap.test.tsx`: mount `<SessionProvider />`, assert exactly one bridge call to `installShellIntegration({confirm:true})`; second mount no-ops.
- **E-B-04** Rust test in `packages/host-tauri/src-tauri/src/ipc.rs` (under `#[cfg(test)]`): `install_shell_integration` idempotency + shebang refusal.
- **E-B-05** Opt-out gate: with `QUANTA_NO_AUTOINSTALL=1`, zero bridge calls. With `shellIntegration.autoInstall=false` in settings, zero bridge calls.

### Dependencies
- None on other P1 epics (independent of boundary detector — auto-install is purely integration shell).
- Stands alone: a user on flag.blockUx=false can still benefit (OSC 7 cwd, OSC 1337 cwd, OSC 133 exit code are all consumable by the degraded-mode banner and metrics surface).

### Effort bucket
**small** (orchestration on an already-wired host bridge).

### Risks + mitigations
- **R-B-1** Auto-writing to `~/.zshrc` is surprising to power users who manage dotfiles with git / chezmoi / home-manager. *Mitigation*: banner surfaces "Quanta modified `~/.zshrc`" with a prominent "Undo" action; guard markers make uninstall trivial. For users who pre-set `QUANTA_NO_AUTOINSTALL=1` in their env, zero surprise.
- **R-B-2** Nix/immutable rc files throw EROFS on append. *Mitigation*: catch EROFS, emit `reason: 'readonly-fs'`, skip silently with banner, point user to wizard's "copy snippet to clipboard" mode.
- **R-B-3** Corporate-managed shells have rc files included via `source /etc/skel/.zshrc` at the top — snippet at end of user rc may be overridden. *Mitigation*: the existing OSC 133 emitter is idempotent; even if loaded twice it just re-emits the same sequences. Doc note in the ADR.
- **R-B-4** fish users with `config.fish` and additional `conf.d/*.fish` — snippet target is `config.fish` which may not be the canonical location. *Mitigation*: install to `~/.config/fish/conf.d/quanta.fish` instead; existing wizard already does this, auto-install reuses.

### Files
- **New**: `packages/ui/src/features/shell-integration-wizard/detect-shell.ts`
- **New**: `packages/ui/src/features/shell-integration-wizard/auto-install.ts`
- **New**: `packages/ui/src/features/shell-integration-wizard/__tests__/auto-install.test.ts`
- **New**: `packages/ui/src/features/shell-integration-wizard/__tests__/detect-shell.test.ts`
- **New**: `packages/ui/src/__tests__/integration/auto-install-bootstrap.test.tsx`
- **Update**: `packages/ui/src/features/session/engine.ts` (bootstrap hook)
- **Update**: `packages/ui/src/widgets/shell-integration-banner/ShellIntegrationBanner.tsx`
- **Update**: `packages/host-tauri/src-tauri/src/ipc.rs` (shebang refusal, `uninstall_shell_integration`)
- **Update**: `packages/ui/src/widgets/settings-panel/` (new setting)
- **Update**: `docs/adr/` — author **ADR 0022 Auto-install integration** (deferred from P0 §11).

---

## Epic P1-C — Block overlay chrome

**Wave 1 status**: `landed (wave 1)` + `integration pending (wave 2)`.
- Spine: `widgets/block-overlay/BlockOverlay.tsx` + `BlockOverlayHost.tsx` (absolute-positioned cards reading row ranges from engine). `Block` entity reworked to `rowRange` schema. Public `pinRows` / `unpinRows` API on `VtEmulator`. Boundary listener (`features/command/block-boundary-listener.ts`) creates / finalizes blocks on `prompt_start` / `command_end`. 29 BlockOverlay tests + boundary-listener + rowRange entity tests.
- Wave-2 integration: C10 — `block.outputChunks` field deletion from `entities/block/model.ts` (remaining readers in `features/ai-explain/` / `features/ai-suggest/` / `features/block/export.ts` not yet fully migrated to grid-read); CI rule `no-block-chunks-in-render` flip to `--strict` with zero allowlist (currently strict + 2 DEFER); C9 — drop `BlockCard` DEFER from `one-render-path`; ADR 0028; legacy `block-list/` / `block-card/` widgets still parked alongside new `block-overlay/` — wave 2 either deletes or unifies.

### Goal
Render `BlockCard` as an absolutely-positioned DOM overlay pinned to a contiguous scrollback row-range, with zero byte-path involvement and zero measurable FPS hit on the grid below. Card mounts on boundary; unmounts on scroll-past-capture OR user dismiss.

### Entry state
- `widgets/block-card/BlockCard.tsx`, `widgets/block-list/`, `widgets/block-tag-strip/` exist; currently **not** mounted in P0 default (all gated behind `flag.blockUx === false`).
- `widgets/terminal-canvas/` (or equivalent grid renderer) owns pixel layout; row-ID → pixel-Y translation is available via `CellBuffer.getRowTop(rowId)`.
- Scrollback ring in `VtEmulator` has stable `rowId` (append-only; never reused) and an `evictedCount` baseline that increases with eviction.
- Hybrid detector (P1-A) produces `{startRowId, endRowId, confidence, exitCode}` per boundary.

### Exit state
- Block overlay chrome layer sits above the grid canvas; uses `position: absolute` + `transform: translateY(rowTop)` + `height: (endRowId - startRowId) * cellHeight`.
- Scroll + resize re-project: a single rAF-synced observer recomputes overlay offsets without re-rendering card bodies.
- Card body queries grid rows (NOT `outputChunks`) for content display; uses existing `shared/lib/text/project-output` for a11y/copy text projection.
- Overlay layer is **opaque at the z-axis** for hit-testing: mouse events on the card don't reach the grid unless the user chords with `Alt` (pass-through).
- When a block's rows are evicted from scrollback, the overlay unmounts and emits a banner "Block output evicted; enable persistent history in settings."

### Work items
C1. New `packages/ui/src/widgets/block-overlay-layer/` — the positioned container. Owns row-ID → pixel-Y translation, scroll listener, resize observer. Mounts only when `flag.blockUx === true`.
C2. Rewrite `widgets/block-card/BlockCard.tsx` to read content from `VtEmulator.getScrollback().rowsInRange(startId, endId)` instead of `block.outputChunks`. Uses `shared/lib/text/project-output`.
C3. New `packages/ui/src/widgets/block-overlay-layer/useRowProjection.ts` — hook that subscribes to scroll + resize and yields `{rowId → {top, height}}` for visible row ranges. Returns `null` when row is evicted (triggers unmount).
C4. Hit-test semantics: overlay cards intercept click/scroll on themselves; `Alt`-chord sends the event through to the grid. Wired via `pointer-events: auto` + synthetic `Alt` listener.
C5. BlockList → BlockOverlayLayer migration: `widgets/block-list/BlockList.tsx` no longer renders flow-layout cards; becomes a thin mapper from `useBlockStore().blocks` to `<BlockCard />` children of the overlay layer.
C6. Scroll-past-capture: when a block's range scrolls out of viewport + buffer margin (2 × viewport height), the card unmounts (memory budget). Re-mounts when scrolled back into range.
C7. Eviction handling: when `scrollback.getEvictedCount() > block.endRowId`, unmount card AND dispatch `blockStore.markEvicted(blockId)`. A frozen "evicted" placeholder renders in scroll history with just the command text + exit code (cheap).
C8. Performance budget: overlay layer must add ≤ 1 ms to paint P99 at 30 visible cards on a 4K display. Measured via existing perf harness (Agent-M scaffold, `__tests__/perf/`).
C9. Update `I-11 one-render-path` CI rule to move `BlockCard` off the DEFER list (currently in rule allowlist per gap-tracking.md). Post-migration BlockCard reads grid, not chunks, so rule goes strict.
C10. Delete `block.outputChunks` field entirely from `entities/block/model.ts` — P0 left it on the type for legacy consumers; C2 removes the last reader. CI rule `no-block-chunks-in-render` moves to `strict` with zero exceptions.

### Exit gates
- **E-C-01** `packages/ui/src/widgets/block-overlay-layer/__tests__/row-projection.test.tsx` (new): mount + scroll + resize + eviction + viewport-margin unmount scenarios.
- **E-C-02** `packages/ui/src/__tests__/integration/block-overlay-visual.test.tsx` (new): feeds a 50-command corpus, asserts overlay cards track row positions across scroll and resize.
- **E-C-03** Perf: `packages/ui/src/__tests__/perf/block-overlay-30-cards.test.ts` (new) — 30 visible cards at 4K, paint P99 ≤ 17 ms (15 ms baseline + 1 ms overlay budget + 1 ms slack).
- **E-C-04** `tools/check-no-block-chunks-in-render/` runs with `--strict`; zero allowlist entries.
- **E-C-05** Byte-accounting still holds across C-BD-01 with chrome mounted.

### Dependencies
- P1-A (needs confidence-stamped boundaries).
- P1-B (not strict; helpful because OSC 133 boundaries exercise the exit-code path).
- P0 α3 scrollback ring stable rowId (landed).

### Effort bucket
**large** (full widget-tier migration + perf work + rule tightening).

### Risks + mitigations
- **R-C-1** Scroll jitter on heavy output when overlay reprojects every frame. *Mitigation*: reprojection is rAF-coalesced and only recomputes for cards in the visible range + 2-viewport margin. Microbench target: 0.2 ms per reprojection for 30 cards.
- **R-C-2** Overlay hit-testing shadows copy/paste on the grid. *Mitigation*: card body has `user-select: text` for its own content; Alt-chord to pass through to grid selection; explicit test in E-C-02.
- **R-C-3** Row eviction race — card is mid-render when underlying row evicts. *Mitigation*: `useRowProjection` hook is null-safe on eviction; renders empty placeholder for one frame then unmounts.
- **R-C-4** Legacy `block.outputChunks` consumers in `features/ai-explain/`, `features/ai-suggest/`, `features/block/export.ts` will break on C10. *Mitigation*: those features all get grid-read migrations before C10. (Already scaffolded — `shared/lib/text/project-output` exists per Agent-I's work.)

### Files
- **New**: `packages/ui/src/widgets/block-overlay-layer/BlockOverlayLayer.tsx`
- **New**: `packages/ui/src/widgets/block-overlay-layer/useRowProjection.ts`
- **New**: `packages/ui/src/widgets/block-overlay-layer/block-overlay-layer.module.css`
- **New**: `packages/ui/src/widgets/block-overlay-layer/__tests__/row-projection.test.tsx`
- **New**: `packages/ui/src/__tests__/integration/block-overlay-visual.test.tsx`
- **New**: `packages/ui/src/__tests__/perf/block-overlay-30-cards.test.ts`
- **Rewrite**: `packages/ui/src/widgets/block-card/BlockCard.tsx` (grid-read)
- **Rewrite**: `packages/ui/src/widgets/block-list/BlockList.tsx` (overlay mapper)
- **Update**: `packages/ui/src/entities/block/model.ts` (drop `outputChunks` field)
- **Update**: `packages/ui/src/entities/block/selectors.ts`, `persistence.ts` (drop chunk dependence)
- **Update**: `packages/ui/src/features/block/export.ts` (read via `project-output`)
- **Update**: `tools/check-no-block-chunks-in-render/` (strict mode)
- **Update**: `tools/check-one-render-path/` (drop BlockCard DEFER entry)
- **Delete**: none — legacy widgets remain flag-gated but now use grid source.

---

## Epic P1-D — Mode-stack polish

**Wave 1 status**: `landed (wave 1)` + `polish pending (wave 2)`.
- Spine: `features/mode-stack/` with 5 drivers (alt-screen, multiplexer, pager, REPL, nested-shell). Policy — input walks top→bottom for non-passthrough; mouse innermost-wins; render topmost chrome wins. 40 tests including depth-4 nested scenario (tmux / ssh / tmux+tui).
- Wave-2 polish: ADR 0026 authoring; dedicated `widgets/mode-hints/ModeHints.tsx` widget (wave 1 overlapped with P1-G `ghost-hint/` — wave 2 either consolidates or splits mode-pill vs ghost-text responsibilities); C-MUX-03 click-reach assertion extension to prove mouse arbitration at depth 3 reaches innermost tmux (E-D-02 strengthening).

### Goal
Produce a stack-aware terminal-mode model that tracks nested alt-screen entries (pager inside editor inside tmux), exposes per-level DEC mouse-mode arbitration, and renders REPL continuation-prompt affordances. Eliminates the P0-era "we collapse to one bool" behavior.

### Entry state
- `features/tui/detect.ts` runs a byte-level FSM for alt-screen enter/exit (DEC 1049/1047/47).
- `VtEmulator` emits `ModeChanged{altScreen}` but there is no stack — nested tmux-in-ssh-in-tmux is modeled as a single bool.
- Compat fixture `C-MUX-03` (tmux-in-ssh-in-tmux depth 3) exists but does not assert mode-stack correctness — just that bytes render.
- Hybrid boundary detector (P1-A) does NOT emit boundaries inside alt-screen (ADR 0002 correctly).
- Some REPL tracking: `features/command/` recognizes python `>>>`, `...`, node `>`, `...` via prompt-regex — not yet wired to chrome.

### Exit state
- `packages/ui/src/features/tui/mode-stack.ts` owns a `ModeStack` with `{kind: 'main' | 'alt' | 'repl-continuation' | 'pager', depth, enteredAtRowId}[]`.
- On nested alt-screen entry, depth increments; on exit, depth decrements. Inconsistent exits (e.g. SIGHUP inside nested tmux) recover via a resync message from sidecar.
- DEC mouse modes (1000/1002/1003/1006/1015) arbitrate: outermost-to-innermost claim; last-setter wins for a given coordinate space. Exposed as `modeStack.getActiveMouseMode(depth)`.
- Pager hint ("press q to quit") renders in a non-intrusive pill when the detector identifies a pager pattern (alt-screen + cursor-home + `:` / `--More--` prompt).
- REPL continuation banner renders `(indent continues)` affordance in chrome when in `repl-continuation` mode.

### Work items
D1. New `packages/ui/src/features/tui/mode-stack.ts` — stack data structure + push/pop + invariant checks. Pure.
D2. Extend `features/tui/detect.ts` FSM to emit stack-deltas instead of single `altScreen` flag. Existing single-bool consumer gets a helper `isAnyAltActive(): boolean = stack.some(l => l.kind === 'alt')`.
D3. Pager detector: new `packages/ui/src/features/tui/pager-detect.ts` — matches `less`, `more`, `man`, `git --paginate` via cursor-home + prompt-regex-pager. Emits `modeStack.push({kind:'pager', ...})`.
D4. REPL continuation detector: new `packages/ui/src/features/tui/repl-detect.ts` — extends the prompt-regex scheme from P1-A with per-REPL continuation patterns. Emits `modeStack.push({kind:'repl-continuation', ...})` on `...`, `...>`, `|`.
D5. Mouse-mode arbitration: `packages/ui/src/features/input/mouse-encoder.ts` consults `modeStack.getActiveMouseMode()` instead of reading the flat mode flag. Depth-3 tmux-in-ssh-in-tmux test exercises this.
D6. Chrome affordances: new widget `packages/ui/src/widgets/mode-hints/ModeHints.tsx` — renders a pill for `pager` / `repl-continuation` mode. Positioned above the composer (when composer is mounted) or bottom-right of grid.
D7. Recovery surface: on sidecar resync (happens after crashes, detach/reattach cycles), `modeStack.reset()` + a banner "terminal state resynced; nested depth restored via shell integration if present."
D8. Instrumentation: `quanta.modestack.depth_p99` gauge, `quanta.modestack.push_total{kind}`, `quanta.modestack.pop_mismatch_total`.

### Exit gates
- **E-D-01** `packages/ui/src/features/tui/__tests__/mode-stack.test.ts` (new): push/pop, nested depth, mismatch recovery, serialization for session restore (P1-E dependency).
- **E-D-02** Extend `packages/ui/src/__tests__/compat/C-MUX-03-tmux-in-ssh-in-tmux.test.ts`: assert `modeStack.depth === 3` at peak, mouse click at depth 3 reaches innermost tmux.
- **E-D-03** `packages/ui/src/features/tui/__tests__/pager-detect.test.ts` (new): `less`, `man git-log`, `more /etc/hosts` all produce pager-kind stack entry.
- **E-D-04** `packages/ui/src/features/tui/__tests__/repl-detect.test.ts` (new): python indented function, node multi-line arrow, bash heredoc.
- **E-D-05** `packages/ui/src/widgets/mode-hints/__tests__/ModeHints.test.tsx` (new): pill renders for pager/REPL; hides in main mode.

### Dependencies
- P1-C (chrome mount point for ModeHints).
- P1-A (shared prompt-regex registry from A3).

### Effort bucket
**medium** (detector work + widget + test matrix).

### Risks + mitigations
- **R-D-1** Stack imbalance from abnormal shell exits leaves stale entries. *Mitigation*: sidecar resync message clears the stack; stack depth > 8 logs a warning and forces a reset (cap).
- **R-D-2** Pager-detector false-positives on scripts that cursor-home mid-output (gnuplot, fbterm demos). *Mitigation*: require alt-screen + cursor-home + prompt-regex pager-style match; mere cursor-home without alt-screen is NOT a pager.
- **R-D-3** Mouse arbitration bug at depth 3+ is hard to reproduce without a real tmux session. *Mitigation*: the compat fixture C-MUX-03 is already recorded; extend it with click-reach assertions.

### Files
- **New**: `packages/ui/src/features/tui/mode-stack.ts`
- **New**: `packages/ui/src/features/tui/pager-detect.ts`
- **New**: `packages/ui/src/features/tui/repl-detect.ts`
- **New**: `packages/ui/src/widgets/mode-hints/ModeHints.tsx`
- **New**: `packages/ui/src/widgets/mode-hints/mode-hints.module.css`
- **New**: `packages/ui/src/features/tui/__tests__/mode-stack.test.ts`
- **New**: `packages/ui/src/features/tui/__tests__/pager-detect.test.ts`
- **New**: `packages/ui/src/features/tui/__tests__/repl-detect.test.ts`
- **New**: `packages/ui/src/widgets/mode-hints/__tests__/ModeHints.test.tsx`
- **Update**: `packages/ui/src/features/tui/detect.ts` (emit stack deltas)
- **Update**: `packages/ui/src/features/input/mouse-encoder.ts` (depth-aware arbitration)
- **Update**: `packages/ui/src/__tests__/compat/C-MUX-03-*.test.ts`
- **Update**: `docs/adr/` — author **ADR 0026 Mode Stack** (deferred from P0 §11).

---

## Epic P1-E — Session restore (replay events journal)

**Wave 1 status**: `landed (wave 1)` + `integration pending (wave 2)`.
- Spine: Rust `session_record.rs` writer (11 tests) with 512 B header + FR (Frame Record) format, 50 MB rotation × 4 files. TS replay engine (`features/session-restore/replay.ts`, 15 tests) with storm-threshold snapshot fallback. `flag.sessionRestore` default `false`. UI wire-in via `TerminalPage` effect.
- Wave-2 integration: ADR 0027 authoring; privacy-redaction pass (`__tests__/journal-secret-redaction.test.ts`, E-E-05) — wave-1 journal writes plaintext bytes, secret-detect integration deferred; Safari private-mode fallback banner (R-E-2 mitigation); flag-flip criteria — default-on gated on durability audit + journal-schema-v2 forward-compat review for P2-A Run entity persistence.

### Goal
Persist a per-session event journal (input bytes + PTY bytes + mode deltas + boundary events + cwd snapshots) and replay it on reload to reconstruct the `GridSnapshot` + `ModeStack` + block list without re-running the shell.

### Entry state
- `features/session-record/recorder.ts` already implements asciicast v2 output-only recording with a 32 MiB cap (not used for session restore; it's a user-facing recording feature).
- `entities/block/persistence.ts` persists block metadata to IndexedDB.
- `entities/session/persistence.ts` persists session tabs + tab metadata.
- No grid-snapshot-at-checkpoint; no input-byte journal; no replay engine.
- `VtEmulator.feed(bytes)` is deterministic given same initial state + input.

### Exit state
- `features/session/event-journal.ts` writes to IndexedDB every 1 s: a delta-encoded event stream of {PTY bytes, input bytes, resize events, OSC 133/7 events, boundary emissions} with hourly snapshots.
- On session reload, `features/session/replay.ts` reads the latest snapshot + replays events → reconstructs grid + mode stack + block list.
- Restoration is **read-only** — no shell is spawned; the session appears frozen-at-last-state until the user hits "reconnect" (which spawns a fresh shell in the same cwd).
- Replay under 500 ms for a typical 30-minute session (< 10 MiB journal).
- Capped journal: 128 MiB per session, circular; snapshots evict oldest first.

### Work items
E1. New `packages/ui/src/features/session/event-journal.ts` — append-only IndexedDB writer. Buffers 1 s, flushes as CRDT-style delta batch.
E2. New `packages/ui/src/features/session/snapshot.ts` — `GridSnapshot` serializer (existing type exported from `vt-emulator/`) + deserializer. Handles scrollback row IDs + pin state.
E3. New `packages/ui/src/features/session/replay.ts` — loads latest snapshot, feeds delta events through a fresh `VtEmulator` (same clock as original, or synthetic clock for timing-independent replay). Produces the final state.
E4. Journal schema V1 in `packages/ui/src/features/session/journal-schema.ts` — versioned for forward compat; `schemaVersion: 1` rejected on `3`, upgrade path from `1 → 2` documented.
E5. Wire into `features/session/engine.ts`: on init, check for journal; if present, hydrate grid + mode stack + block list before the first `VtEmulator.feed`. On shutdown, flush final batch.
E6. UI surface: `widgets/session-tabs/` adds a "frozen" tab state (dashed border) when restored-from-journal but not yet reconnected. "Reconnect" button spawns new shell in the last known cwd.
E7. Journal rotation: 128 MiB cap; LRU eviction of oldest snapshot's deltas; newest snapshot preserved.
E8. Privacy: journal respects the existing secret-detect rules — any byte range that matched a secret pattern is stored redacted. Reuses `features/secret-detect/` machinery.
E9. Host-side: journal file path negotiated through `packages/host-tauri/src-tauri/src/ipc.rs` — IndexedDB in browser; actual filesystem in Tauri for durability across app restarts.

### Exit gates
- **E-E-01** `packages/ui/src/features/session/__tests__/event-journal.test.ts` (new): 1 s batch flush, delta compression, schema version rejection.
- **E-E-02** `packages/ui/src/features/session/__tests__/replay.test.ts` (new): replay of recorded 30-minute journal produces byte-identical grid to live session (compare via `GridSnapshot` hash).
- **E-E-03** Perf: replay of 10 MiB journal completes in < 500 ms on M1 / < 800 ms on GH Actions Linux runner.
- **E-E-04** `packages/ui/src/__tests__/integration/session-restore-reload.test.tsx` (new): full UI cycle — record session, simulate reload, assert tab appears frozen with correct grid content.
- **E-E-05** Privacy: `__tests__/journal-secret-redaction.test.ts` — secrets in recorded bytes appear as `REDACTED` markers in persisted journal.

### Dependencies
- P1-C (block list must hydrate from restored state, not re-run boundaries).
- P1-D (mode stack must serialize/deserialize).
- Post-C: session restore is meaningless without blocks. Sequenced after C.

### Effort bucket
**large** (schema + serializer + replay engine + privacy integration + IDB capacity work).

### Risks + mitigations
- **R-E-1** `VtEmulator.feed` determinism relies on no-wall-clock-reads; a future engine change (e.g. idle-timer-based effect) would break replay. *Mitigation*: document in ADR that the engine must be clock-injectable; idle detector (P1-A, A4) already uses an injected clock.
- **R-E-2** IndexedDB in Safari private mode throws. *Mitigation*: fall back to in-memory (session-lifetime) journal + banner "session restore disabled in private mode."
- **R-E-3** Journal grows faster than 128 MiB on heavy sessions. *Mitigation*: snapshot every hour; only keep last 2 snapshots + their delta tails; older snapshots dropped silently.
- **R-E-4** Restored session's "cwd" is stale (user renamed the directory between sessions). *Mitigation*: on reconnect, if the cwd doesn't exist, fall back to `$HOME` and emit a banner.

### Files
- **New**: `packages/ui/src/features/session/event-journal.ts`
- **New**: `packages/ui/src/features/session/snapshot.ts`
- **New**: `packages/ui/src/features/session/replay.ts`
- **New**: `packages/ui/src/features/session/journal-schema.ts`
- **New**: `packages/ui/src/features/session/__tests__/event-journal.test.ts`
- **New**: `packages/ui/src/features/session/__tests__/replay.test.ts`
- **New**: `packages/ui/src/features/session/__tests__/journal-secret-redaction.test.ts`
- **New**: `packages/ui/src/__tests__/integration/session-restore-reload.test.tsx`
- **Update**: `packages/ui/src/features/session/engine.ts` (hydrate path)
- **Update**: `packages/ui/src/widgets/session-tabs/` (frozen tab state)
- **Update**: `packages/host-tauri/src-tauri/src/ipc.rs` (journal file persistence in Tauri)
- **Update**: `packages/ui/src/features/secret-detect/` (redaction integration)

---

## Epic P1-F — Output search across scrollback

**Wave 1 status**: `landed (wave 1)` + `polish pending (wave 2)`.
- Spine: `features/output-search/scrollback-search.ts` grid-wide indexer searching both scrollback ring + viewport. `widgets/find-panel/` with `Cmd+F` + debounced input + match count + `Enter` / `Shift+Enter` navigation. `CellBuffer.searchHighlights` API. 31 tests including perf (10k rows × 30 matches < 50 ms). `sgrDigest` + widths preserved.
- Wave-2 polish: F8 persistent-history fallback (depends on P1-E flag-on); `C-SEARCH-01` compat fixture (10k rows big-corpus); regex timeout enforcement (R-F-2 mitigation); web-worker-backed index for 100k-row custom caps (R-F-1).

### Goal
Full-text search across the entire scrollback ring (not just the current viewport, not just per-block), with per-match navigation, highlight overlay, and case / regex / whole-word toggles. Reuses the existing per-block search machinery as a projection.

### Entry state
- `features/output-search/` ships per-block scoped search: `query.ts`, `highlight.ts`, `recompute.ts`, `search-store.ts`, `use-block-matches.ts`, `cross-block.ts`.
- `widgets/output-search/OutputSearch.tsx` is a per-block search bar.
- Scrollback ring in `VtEmulator` exposes `rowsInRange(startId, endId)` (to be added in P1-A A8) and grapheme-aligned cell content.
- No cross-scrollback index; search is re-computed per keystroke.

### Exit state
- Global search spans the entire active scrollback ring (bounded by config `scrollbackRows` default 10k).
- Incremental search index built on demand: cold start ≤ 50 ms for 10k rows, ≤ 150 ms for 100k rows.
- Match navigation: `Cmd+G` next, `Cmd+Shift+G` prev; grid auto-scrolls to match and highlights.
- Case / regex / whole-word toggles in search bar.
- Match overlay uses the existing highlight mechanism (`features/output-search/highlight.ts`) generalized to grid row ranges.
- Search-over-evicted-content: if the user's pattern would match content that has scrolled out of the ring, a banner offers "persistent history search" (P1-E journal read).

### Work items
F1. New `packages/ui/src/features/output-search/scrollback-index.ts` — builds a line-indexed inverted index over `scrollback.rowsInRange(0, evictedCount+ringSize)`. Lazy; rebuilds on eviction events only.
F2. New `packages/ui/src/features/output-search/scrollback-query.ts` — executes a `Query` (reuses existing `query.ts` types) against the index. Returns `{rowId, col, length}[]`.
F3. Generalize `features/output-search/highlight.ts` — currently per-block; extend to accept row-range matches. Overlay renders via cell-renderer damage set (reuse of `DamageSet`).
F4. Widget: rewrite `widgets/output-search/OutputSearch.tsx` to sit above the grid (not inside a block card). Input field + toggles + match counter (`23 / 512 matches`).
F5. Keybindings: `Cmd+F` open, `Cmd+G` next, `Cmd+Shift+G` prev, `Escape` close. Wired through `features/keybindings/`.
F6. Auto-scroll: on match selection, `TerminalSurface` smooth-scrolls to match row ID; selection highlights.
F7. Eviction invalidation: when scrollback evicts rows with active matches, affected matches drop silently from the result list; counter updates.
F8. Persistent-history fallback: when current-scrollback index returns zero matches AND `journalEnabled === true` (P1-E), offer "Search history" button — opens a separate panel reading from the event journal.
F9. Perf: index build ≤ 50 ms for 10k rows; incremental query ≤ 10 ms for a 4-char pattern against 10k rows. Enforced in `__tests__/perf/output-search-scrollback.test.ts`.
F10. Instrumentation: `quanta.search.query_total`, `quanta.search.match_count_p99`, `quanta.search.index_build_ms_p99`.

### Exit gates
- **E-F-01** `packages/ui/src/features/output-search/__tests__/scrollback-index.test.ts` (new): build, incremental update on append, invalidation on eviction.
- **E-F-02** `packages/ui/src/features/output-search/__tests__/scrollback-query.test.ts` (new): literal, case-insensitive, regex, whole-word — 30 cases.
- **E-F-03** Integration: `packages/ui/src/__tests__/integration/output-search-scrollback.test.tsx` (new): open search, type query, navigate matches, verify scroll + highlight.
- **E-F-04** Perf: `packages/ui/src/__tests__/perf/output-search-scrollback.test.ts` budgets (F9).
- **E-F-05** Search over evicted content: banner appears on zero-results with journal present.

### Dependencies
- P1-C (block overlay chrome uses same highlight layer; avoid two highlight mechanisms).
- P1-E (optional for fallback search; P1-F ships without E but gains the fallback surface later).

### Effort bucket
**medium** (index + widget + perf work; builds on an existing feature subtree).

### Risks + mitigations
- **R-F-1** Index build pauses UI on very large scrollbacks (>100k rows if user raises the cap). *Mitigation*: build in a web worker; UI renders a "indexing..." spinner. Budget gated at default cap (10k).
- **R-F-2** Regex search with catastrophic backtracking hangs the worker. *Mitigation*: re2-style linear regex only (reject PCRE-backreferences in the widget UI); 1 s query timeout.
- **R-F-3** Match highlight overlay conflicts with block card overlay (P1-C) at same pixel. *Mitigation*: highlight sits on the cell-renderer layer (below cards); match counter pill sits above. Z-axis explicit.

### Files
- **New**: `packages/ui/src/features/output-search/scrollback-index.ts`
- **New**: `packages/ui/src/features/output-search/scrollback-query.ts`
- **New**: `packages/ui/src/features/output-search/__tests__/scrollback-index.test.ts`
- **New**: `packages/ui/src/features/output-search/__tests__/scrollback-query.test.ts`
- **New**: `packages/ui/src/__tests__/integration/output-search-scrollback.test.tsx`
- **New**: `packages/ui/src/__tests__/perf/output-search-scrollback.test.ts`
- **Rewrite**: `packages/ui/src/widgets/output-search/OutputSearch.tsx` (grid-level)
- **Update**: `packages/ui/src/features/output-search/highlight.ts` (row-range generalization)
- **Update**: `packages/ui/src/features/output-search/recompute.ts`
- **Update**: `packages/ui/src/features/output-search/index.ts`
- **Update**: `packages/ui/src/features/keybindings/` (Cmd+F, Cmd+G)

---

## Epic P1-G — Pager / REPL ghost hints

**Wave 1 status**: `landed (wave 1)` + `polish pending (wave 2)`.
- Spine: `widgets/ghost-hint/` (GhostHint + `hint-registry.ts` + `useModeStack.ts`) — passive bottom-right pill with 9 registry entries (less / man / python / node / psql / tmux / vim / htop / nested-shell). A11y via `aria-live` + tab-focusable. 19 tests.
- Wave-2 polish: per-hint opt-out + settings-panel surface (wave-1 scope only had global toggle; per-hint preferences were flagged as P2 but wave 2 picks up the settings-panel chrome); catalog sync test against shell-integration scripts (R-G-2 mitigation); localisation catalog (`resources/mode-hints/<lang>.json`) beyond `en.json`.

### Goal
Render contextual ghost-text affordances — "press q to quit" under a pager, "SHIFT+ENTER for newline" in a REPL, "ESC to cancel" in an active search-in-buffer — using mode-stack signals (P1-D). Ghost text is a single-line hint pinned to the input area; never modal.

### Entry state
- `features/autosuggest/` ships fish-style ghost-text for command completion. Reusable styling.
- Mode stack (P1-D) knows about pager / repl-continuation / alt-screen depths.
- Pager-detect / repl-detect are live (P1-D D3, D4).

### Exit state
- A `GhostHint` widget is mounted at the grid's bottom-right; subscribes to `modeStack` + context signals and renders a dismissable hint string.
- Hint text set is data-driven: `resources/mode-hints.json` maps `{kind, subkind}` → hint string. Localizable.
- Hints auto-dismiss after 5 s OR on any user keystroke matching the hint's dismiss action.
- Anti-nag: per-hint-kind, once dismissed by keystroke, don't re-show until the user sees a **different** hint kind first.

### Work items
G1. New `packages/ui/src/widgets/ghost-hint/GhostHint.tsx` + module.css. Subscribes to `modeStack` (P1-D), `features/output-search/search-store.ts`, etc.
G2. New `packages/host-tauri/resources/mode-hints/en.json` — hint catalog. `pager.less`, `pager.man`, `repl.python.continuation`, `repl.node.continuation`, `search.active`.
G3. New `packages/ui/src/features/tui/hint-provider.ts` — subscribes to mode stack + search store + composer state; emits current active hint. Pure; reactive via zustand subscriber.
G4. Anti-nag store: `packages/ui/src/features/tui/hint-dismissals.ts` — records `{kind: lastDismissedAt}` per hint kind. Clears on app restart (session-local).
G5. Accessibility: hints use `aria-live="polite"`; screen readers announce once.
G6. Theming: ghost-hint uses the same `--color-text-muted` token as autosuggest for consistency.
G7. Opt-out: settings key `tui.ghostHints: boolean` default `true`; opt-out per-hint-kind planned for P2 (not P1).

### Exit gates
- **E-G-01** `packages/ui/src/widgets/ghost-hint/__tests__/GhostHint.test.tsx` (new): render for each hint kind, auto-dismiss timing, keystroke dismissal, anti-nag.
- **E-G-02** `packages/ui/src/features/tui/__tests__/hint-provider.test.ts` (new): correct hint emitted for each mode-stack state.
- **E-G-03** Integration: `packages/ui/src/__tests__/integration/ghost-hint-less.test.tsx` — open `less /etc/passwd`, hint appears; press `q`, hint dismisses + pager exits.
- **E-G-04** Anti-nag: re-entering pager after keystroke-dismissal doesn't re-show until a different hint kind intervenes.

### Dependencies
- P1-D (mode stack + pager/repl detect).

### Effort bucket
**small** (widget + catalog + provider; builds entirely on P1-D).

### Risks + mitigations
- **R-G-1** Hints are distracting to power users. *Mitigation*: settings toggle + anti-nag by default.
- **R-G-2** Hint catalog drifts out of sync with actual shell behaviors. *Mitigation*: catalog lives with the shell-integration scripts; versioned alongside.

### Files
- **New**: `packages/ui/src/widgets/ghost-hint/GhostHint.tsx`
- **New**: `packages/ui/src/widgets/ghost-hint/ghost-hint.module.css`
- **New**: `packages/ui/src/widgets/ghost-hint/__tests__/GhostHint.test.tsx`
- **New**: `packages/ui/src/features/tui/hint-provider.ts`
- **New**: `packages/ui/src/features/tui/hint-dismissals.ts`
- **New**: `packages/ui/src/features/tui/__tests__/hint-provider.test.ts`
- **New**: `packages/ui/src/__tests__/integration/ghost-hint-less.test.tsx`
- **New**: `packages/host-tauri/resources/mode-hints/en.json`
- **Update**: `packages/ui/src/widgets/settings-panel/` (new `tui.ghostHints` setting)

---

## Epic P1-H — Perf live in CI

**Wave 1 status**: `landed (wave 1)` + `integration pending (wave 2)`.
- Spine: `ci-linux` budget profile 3× wider vs local M4 Max, `tools/perf-regression-check.mjs` (last-7-main median comparator with 20 % delta threshold), nightly artifact prune job, `tools/check-perf-ready.mjs` smoke, updated `tools/run-perf-budget.mjs`. 19 tool tests.
- Wave-2 integration: per-OS baseline files (`tools/perf-baseline.json` committed + `tools/perf-baseline-macos.json`); GitHub PR comment bot for perf diff (H6); absorb P0 gate 7 (perf green-at-budget) close-out via CI nightly run capture; flake policy alignment with test-strategy.md §5.3 (median-of-3).

### Goal
Close the only remaining P0 gate — "perf budgets green in CI on every PR" — by wiring Agent-M's perf harness scaffold into GitHub Actions with budget enforcement. This is infrastructure that P0 scaffolded but did not connect; landing it here prevents regressions as P1 adds chrome.

### Entry state
- `tools/run-perf-budget.mjs` exists (Agent-M, partial).
- `packages/ui/src/__tests__/perf/` has 4 budget tests + `perf-budget.ts` / `fixtures.ts`.
- `vitest.config` honors `VITEST_PERF` opt-in.
- `.github/workflows/perf.yml` or `perf-budget.yml` landed per Agent-V, but not enforced on PRs (may be scaffold-only per gap-tracking.md wave 4 table).
- No baseline snapshot — budgets are asserted as absolute thresholds without trend tracking.

### Exit state
- Perf job runs on every PR; failure blocks merge.
- Nightly baseline job records trend data in `tools/perf-baseline.json` (committed to main).
- Budget violations within 10% of threshold warn; violations over 10% block.
- Compat perf budgets (from ε2 / P0 gate 7) all green.

### Work items
H1. Verify / repair `.github/workflows/perf.yml` — ensure `VITEST_PERF=1` path triggers on PR, compares result to a committed baseline.
H2. Establish baseline: `tools/capture-perf-baseline.mjs` — runs on main branch in nightly job; writes to `tools/perf-baseline.json`.
H3. Budget comparator: `tools/run-perf-budget.mjs` extended to diff against baseline; reports regressions.
H4. Three additional budget scenarios: block-overlay paint (for P1-C), search index build (for P1-F), journal flush (for P1-E).
H5. Flake policy: 3 runs, median judgement (test-strategy.md §5.3). Runner-variance adjusted.
H6. Surface: GitHub PR comment bot posts perf diff as a collapsible table; regressions highlighted.

### Exit gates
- **E-H-01** A PR that regresses `C-MON-01` (top) by 20% is blocked.
- **E-H-02** Nightly main-branch baseline updates committed deterministically.
- **E-H-03** Block overlay + search index + journal budgets have baselines.

### Dependencies
- None — runs alongside all other epics. Recommended to land early in P1 so subsequent epics are perf-guarded.

### Effort bucket
**small** (wiring, no new primitives).

### Risks + mitigations
- **R-H-1** GH Actions runner variance produces flake. *Mitigation*: median-of-3; 10% soft threshold before block.
- **R-H-2** macOS runner (if added) has different baselines than Linux. *Mitigation*: per-OS baseline files.

### Files
- **New**: `tools/capture-perf-baseline.mjs`
- **New**: `tools/perf-baseline.json`
- **New**: `tools/perf-baseline-macos.json`
- **Update**: `.github/workflows/perf.yml`
- **Update**: `tools/run-perf-budget.mjs`

---

## Epic P1-I — Sign-off automation

**Wave 1 status**: `landed (wave 1)` + `integration pending (wave 2)`.
- Spine: `tools/ship-signoff-gen/` with 12 gate runners (`gates.mjs` 448 LOC) + `format.mjs` renderer + `compare.mjs` drift classifier (tier 2 / 3 alerting). `ship-signoff-weekly.yml` Monday 14:00 UTC cron with GH issue creation / update via `actions/github-script`. 34 tests.
- Wave-2 integration: drift-job PR auto-open path (wave-1 validated only in unit harness; first live cron observation pending wave 2); per-epic rule additions as wave-2 polish items land (P1-A ADR 0021 rule, P1-C C10 chunks-delete rule, etc.); extension to P2 gate set once p2-roadmap.md epics enter ship-tracking.

### Goal
Automate the `SHIP_SIGNOFF.md` generation so the 12-gate (P0) / 12-gate (P1) scorecards never drift from ground truth. Runs weekly in CI; opens a PR with the updated scorecard if drift is detected.

### Entry state
- Plan 0005 §12 defines the P0 ship gates manually (12 items).
- `gap-tracking.md` has a live scorecard that's hand-updated after each agent wave.
- No automation — drift is only caught on human review.
- Wave 4 Agent-Z (ship gate sign-off) was not delivered (token limit).

### Exit state
- `tools/generate-signoff/` runs `pnpm check:signoff` — scans CI rule outputs, compat fixture count, perf budget green rate, ADR presence, and emits a fresh `SHIP_SIGNOFF.md`.
- Weekly GH Action compares generated vs committed; opens a PR with the diff on drift.
- Each P1 epic adds its own gates to the generator's rule set (via extension).

### Work items
I1. New `tools/generate-signoff/index.mjs` — reads CI rule outputs, compat fixture counts, perf baseline, ADR index; emits `SHIP_SIGNOFF.md` in a stable format.
I2. New `tools/generate-signoff/rules/` — plugin directory; each P0 / P1 gate has a rule file that implements `checkGate() → {gate, status, evidence}`.
I3. New `.github/workflows/signoff-drift.yml` — weekly cron; opens PR on drift.
I4. Initial P0 SHIP_SIGNOFF.md at repo root (supersedes the ad-hoc scorecard in gap-tracking.md).
I5. P1 epic hooks: each P1 epic owner adds a rule file upon ship (A → `rules/P1-A-boundary.mjs`, etc.).

### Exit gates
- **E-I-01** `tools/generate-signoff/__tests__/rules.test.mjs` (new): mocked CI outputs produce expected SHIP_SIGNOFF.md.
- **E-I-02** Drift job runs successfully on main; no drift on a clean tree.

### Dependencies
- None — standalone infrastructure.

### Effort bucket
**small**.

### Risks + mitigations
- **R-I-1** Rule files drift from reality if epic owners forget to add them. *Mitigation*: PR template checkbox "add sign-off rule" for any P1 epic landing.
- **R-I-2** False-positive drift on runner-variance metrics. *Mitigation*: rules emit status + evidence; reviewer can accept the PR or adjust the rule.

### Files
- **New**: `tools/generate-signoff/index.mjs`
- **New**: `tools/generate-signoff/rules/P0-gate-01-no-block-chunks.mjs`
- **New**: `tools/generate-signoff/rules/P0-gate-02-one-input-path.mjs`
- **New**: `tools/generate-signoff/rules/` (10 more for remaining P0 gates)
- **New**: `tools/generate-signoff/__tests__/rules.test.mjs`
- **New**: `.github/workflows/signoff-drift.yml`
- **New**: `SHIP_SIGNOFF.md` (top-level)

---

## Cross-cutting concerns

### ADR dependencies

P1 authors the ADRs deferred by P0 §11:

- **ADR 0021 Hybrid boundary detector** (P1-A) — confidence model, retraction semantics.
- **ADR 0022 Auto-install shell integration** (P1-B) — opt-out policy, rollback, shebang refusal.
- **ADR 0026 Mode Stack** (P1-D) — depth semantics, mouse-mode arbitration, recovery.
- **ADR 0027 Session restore journal** (P1-E) — schema versioning, replay determinism, privacy.
- **ADR 0028 Block overlay chrome** (P1-C) — pixel-layer contract with grid renderer.

ADRs 0023 (Run entity), 0024 (Intent router), 0025 (Priority classes) remain P2.

### Migration from P0 flags

- **`flag.blockUx`** — default flips from `false` to `true` at the end of P1-C landing. P1-A / P1-B may run with flag=false for auto-install (not coupled to chrome).
- New flags are **additive** (default-off): `flag.autoInstallShellIntegration` (P1-B opt-out mechanism), `flag.sessionRestore` (P1-E, default on in Tauri, off in browser), `flag.ghostHints` (P1-G, default on).
- Flag flip in P1-C requires passing P0 gates 1–12 AND P1 gates A / B / C. A separate flag-flip PR gates the ship.

### Test strategy additions

- **New compat fixtures**: C-BD-01, C-BD-02 (hybrid boundary), C-RESTORE-01 (session restore roundtrip), C-SEARCH-01 (scrollback search big-corpus).
- **New perf scenarios**: block-overlay-30-cards, search-index-10k, journal-flush-1s. All baseline-tracked under P1-H.
- **New integration fixtures**: block-overlay-visual, session-restore-reload, output-search-scrollback, ghost-hint-less, auto-install-bootstrap.
- **CI rule tightening**: `no-block-chunks-in-render` moves to strict (P1-C C10); `one-render-path` drops BlockCard DEFER (P1-C C9); `one-input-path` closes TuiRenderSurface DSR path (residual P0 work subsumed).

---

## Rollout sequence

```
        ┌─────────────┐   ┌─────────────┐
        │  P1-A       │   │  P1-B       │   (parallel; independent)
        │  Hybrid     │   │  Auto-      │
        │  detector   │   │  install    │
        └──────┬──────┘   └──────┬──────┘
               │                 │
               └────────┬────────┘
                        ▼
                ┌──────────────┐
                │  P1-C        │   (depends on A for boundaries;
                │  Block       │    B optional but helpful)
                │  overlay     │
                └──────┬───────┘
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
      ┌─────────┐           ┌──────────┐
      │ P1-D    │           │ P1-F     │   (parallel after C)
      │ Mode    │           │ Search   │
      │ stack   │           │ scrollback│
      └────┬────┘           └──────────┘
           │
           ├───────────────┐
           ▼               ▼
      ┌─────────┐    ┌──────────┐
      │ P1-E    │    │ P1-G     │
      │ Session │    │ Ghost    │
      │ restore │    │ hints    │
      └─────────┘    └──────────┘

Infrastructure (run throughout, no sequential dependency):
  P1-H Perf-live-in-CI  — land first for perf-guarded subsequent work
  P1-I Sign-off         — land anytime; weekly job picks up future gates
```

Suggested lane: `{H, I}` land first (infrastructure); `{A, B}` parallel; `C` depends on `{A, B}`; `{D, F}` parallel after `C`; `E` after `D`; `G` after `D`.

Total duration budget (effort buckets): small×4 + medium×3 + large×2 = ~ `3 medium equivalent` small + `3 medium` + `2 large`. No calendar.

---

## Done definition (P1 ship gates)

Mirrors P0's 12-gate structure. All must be green to declare P1 shipped.

1. **Block UX mounted by default** — `flag.blockUx === true` default; P0 plain-grid remains available via `QUANTA_FLAG_BLOCK_UX=off`.
2. **OSC 133 boundary hit rate ≥ 99%** on dogfood sessions (C-BD-01 compat + live dogfood telemetry for 7 days).
3. **Heuristic boundary accuracy ≥ 90%** in no-integration mode (C-BD-02 compat).
4. **Auto-install success rate ≥ 95%** on supported shells (bash, zsh, fish) across macOS + Linux dogfood.
5. **Block overlay paint P99 ≤ 17 ms** at 30 visible cards on 4K display (E-C-03 perf budget).
6. **Mode stack depth ≥ 3** supported end-to-end (C-MUX-03 compat).
7. **Session restore round-trip byte-identical** on 30-minute recorded session (E-E-02).
8. **Scrollback search P99 ≤ 10 ms** for 4-char pattern over 10k rows (E-F-04).
9. **Zero `block.outputChunks` readers** in the codebase (C10 + strict CI rule).
10. **All P1 ADRs (0021, 0022, 0026, 0027, 0028) landed** and referenced in README.
11. **P1 epics green in SHIP_SIGNOFF.md** (P1-I auto-generated).
12. **Perf regression gate active on PRs** (P1-H baseline comparator enforced).

Until all twelve hold, P1 does not ship.

---

## Non-goals

Explicitly **scheduled for P2** — see [p2-roadmap.md](./p2-roadmap.md) for the full spec. Do NOT add scope creep in P1 wave 2:

- **Run entity** (P2-A) — Block stays a projection of boundary events in P1. No `Run` first-class lifecycle.
- **Intent layer** (P2-B) — User keystrokes and agent actions remain untyped bytes through `input-host`. No intent classification.
- **Priority-classified output + priority backpressure** (P2-C) — Frame-skip + flow-control from P0 γ remains the only backpressure policy.
- **Structured output types** (P2-D) — `table`, `progress`, `json-stream`, `binary` render hints. Block UX in P1 handles text only.
- **Agent tool-call surface** (P2-E) — Agent-as-Run chrome deferred.
- **Per-run resource usage sampling** (P2-F) — CPU / mem / net per command. Sidecar support would be needed; not in P1.
- **Replay CLI UX** (P2-G) — P1-E provides the replay engine; a CLI to mount external recordings into the UI waits for P2.

Also out of scope for P1:

- Windows ConPTY parity (RFC 0001 Epic K, separate track).
- Mobile / iPad ports.
- Plugin system (Plan 0004, separate).
- WebGL renderer (Plan 0002, separate).
- Inline images (Plan 0003, separate).

---

## Glossary (delta over README §15)

- **Authoritative boundary** — OSC 133 D emission from shell integration; carries exit code.
- **Heuristic boundary** — prompt-regex + cursor-home match when OSC 133 absent; no exit code.
- **Idle boundary** — 800 ms-quiescent backstop; `exitCode = null`; retracted by later authoritative.
- **Confidence stamp** — `'authoritative' | 'heuristic' | 'idle' | 'synthetic'` carried with every boundary emission.
- **Mode stack** — LIFO of `{kind, depth, enteredAtRowId}` tracking nested alt-screen / pager / REPL contexts.
- **Pin lifecycle** — hybrid detector owns `scrollback.pinRow / unpinRow`; BlockCard does not pin independently.
- **Journal** — persisted per-session event stream (PTY + input + mode deltas + boundaries); replayed on session restore.
- **Ghost hint** — non-intrusive single-line context-aware affordance ("press q to quit") rendered at grid bottom-right.
