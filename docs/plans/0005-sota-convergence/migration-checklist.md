# Plan 0005 — Test & Widget Migration Checklist

- **Status**: Draft v1 (2026-04-21)
- **Purpose**: inventory every test and widget that must migrate when P0 lands
- **Applies to**: Epic δ (P0 default gating) and Epic β (input path)

---

## 0. Three buckets

Every existing test or widget falls into one of:

1. **KEEP** — tests terminal-level behavior (encoders, VT engine, grid, resize, paste, IME). Continues in P0.
2. **MIGRATE** — rewrites for new surface/invariants. Same intent, new implementation.
3. **P1-GATE** — tests block UX. Moves behind `flag.blockUx === true`. Stays green in P1 mode only.
4. **DELETE** — tests fake/legacy behavior we're removing (idle-heuristic exit code, fake 0 exits).

---

## 1. E2E tests (`packages/ui/src/__tests__/e2e/`)

Full inventory with disposition. 25 files, 13788 LOC.

| File | LOC | Disposition | Notes |
|------|-----|-------------|-------|
| `ai-explain-flow.e2e.test.tsx` | 301 | P1-GATE | Block-level AI feature |
| `alt-screen-transition.e2e.test.tsx` | 275 | MIGRATE → integration | Now tests engine buffer swap, not TuiRenderSurface mount toggle |
| `aws-cli-interactive.e2e.test.tsx` | 231 | MIGRATE → compat/C-NET-XX | Real TUI flow; becomes compat fixture |
| `command-correction-flow.e2e.test.tsx` | 206 | P1-GATE | "Did you mean?" hint is block-UX |
| `composer-submit.e2e.test.tsx` | 540 | DELETE | Composer-owns-submit is dead; replace with integration test of SessionInputSurface keystrokes |
| `degraded-mode.e2e.test.tsx` | 564 | KEEP (update mocks) | Degraded-mode still applies; input path changes only |
| `full-stack-pipeline.e2e.test.tsx` | 589 | MIGRATE → compat/C-SH-XX | Becomes bash/zsh compat fixtures |
| `ime-bracketed-paste.e2e.test.tsx` | 493 | KEEP (rehouse) | IME + paste is a terminal invariant; move to `__tests__/integration/` |
| `ime-end-to-end.e2e.test.tsx` | 428 | KEEP (rehouse) | Same; integration tier |
| `input-full-loop.e2e.test.tsx` | 710 | KEEP | Full key→byte→render loop |
| `kitty-keyboard-focus.e2e.test.tsx` | 590 | KEEP | Kitty kbd protocol unaffected |
| `less-pagination.e2e.test.tsx` | 485 | MIGRATE → compat/C-PG-01 | Becomes compat fixture |
| `malformed-input-resilience.e2e.test.tsx` | 579 | KEEP | Engine resilience is P0 scope |
| `mouse-tracking.e2e.test.tsx` | 679 | KEEP | Mouse reporting is P0 scope |
| `osc-clipboard-title-marks.e2e.test.tsx` | 470 | KEEP | OSC parsing unaffected |
| `osc8-hyperlink-flow.e2e.test.tsx` | 877 | MIGRATE | OSC 8 render moves to cell renderer |
| `paste-safety-flow.e2e.test.tsx` | 335 | KEEP (rehouse) | Paste safety still applies at input-host |
| `readline-shortcuts.e2e.test.tsx` | 408 | KEEP | Ctrl+R etc. at input-host level |
| `resize-flow.e2e.test.tsx` | 712 | KEEP | Engine resize; P0 scope |
| `session-tab-switch.e2e.test.tsx` | 506 | KEEP | Session tab logic unchanged |
| `streaming-stress.e2e.test.tsx` | 814 | MIGRATE → perf | Becomes perf harness driver |
| `top-htop-realtime.e2e.test.tsx` | 486 | MIGRATE → compat/C-MON-01,02 | Compat fixtures |
| `tui-crash-recovery.e2e.test.tsx` | 374 | KEEP (update mocks) | Engine crash handling |
| `tui-full-flow.e2e.test.tsx` | 705 | MIGRATE → compat/C-ED-01,02 | vim/nvim fixtures |

Totals:
- **KEEP**: 12 files, ~7130 LOC — continue in P0
- **MIGRATE (integration)**: 4 files, ~2030 LOC — move to `__tests__/integration/`
- **MIGRATE (compat)**: 6 files, ~3200 LOC — become golden-stream fixtures
- **MIGRATE (perf)**: 1 file, ~814 LOC — becomes perf harness
- **P1-GATE**: 2 files, ~507 LOC — gated behind `flag.blockUx`
- **DELETE**: 1 file, ~540 LOC — composer-submit legacy

---

## 2. Widgets / features

### Unmounted in P0 default (P1-GATE)

These are NOT rendered when `flag.blockUx === false`. They live in the tree as optional components loaded only in P1.

```
widgets/block-list/
widgets/block-card/
widgets/composer/
widgets/completion-popup/
widgets/shell-integration-banner/
widgets/block-filter-bar/                # if separate
features/ai-suggest/
features/ai-explain/
features/autosuggest/
features/command-correction/
features/path-completion/
features/secret-detect/                  # (paste-safety separate)
features/output-search/                  # block-local search; P1
features/history/ingest-command-palette.ts  # block-boundary-dependent
features/block/
features/compose/
features/composer/                        # (submit + insertText)
```

Strategy: compose these under a single feature flag `flag.blockUx`. When false:
- `TerminalPage.tsx` does not mount `<BlockList />` or `<Composer />`.
- Session output flows directly into `<TerminalSurface />` (grid paint).
- Session input flows into `<SessionInputSurface />`.

### Kept in P0 (structural)

```
features/input/           # input-host, encoders, IME
features/session/         # connect, session tabs
features/tui/detect.ts    # alt-screen byte detector still useful
features/paste-safety/    # moves to input-host.onPasteGate
features/theme/           # theme system unchanged
features/keybindings/     # UI shortcuts (Cmd+K etc.)
features/degraded-mode/
features/font-settings/
features/zoom/
features/session-tabs/
features/pane-tabs/
features/palette/
features/history-search/   # shell history search at the shell level, not block-boundary

widgets/session-tabs/
widgets/pane-grid/
widgets/command-palette/
widgets/history-search/
widgets/terminal-canvas/   # the GPU-less canvas — becomes TerminalSurface
widgets/alt-screen-status/  # may remove or simplify — AltScreen is now an engine flag
widgets/settings-panel/
widgets/toast/
```

### Deleted in P0

```
features/tui/TuiInputSurface.tsx         # replaced by SessionInputSurface
features/tui/TuiRenderSurface.tsx        # replaced by TerminalSurface (always on)
features/command/route-output.ts (bulk)  # idle heuristic path; block boundary code
features/command/execute.ts (bulk)        # submitCommand's bridge.write path
```

Note: `route-output.ts` and `execute.ts` are gutted but may keep small scaffolding for P1 boundary detection that replaces them.

---

## 3. Store migrations

### `useBlockStore`

In P0 default, block store is dormant — never receives `startBlock`. In P1 (flag on), it comes alive fed by boundary events.

- Keep the store code in-tree.
- Hide usage behind `flag.blockUx` reads in all consumer widgets.
- Document: "block store is a P1 presentation layer."

### `useSessionStore`

Unchanged by P0. `cwd` updates via `predictCwdAfter` heuristic + OSC 7 subscription.

### `useTuiStore` (alt-screen)

Replaced by direct engine query. Delete the zustand store; components that need "is alt buffer active" call `engine.isAltBuffer()`.

### `useAiSuggestStore`, `useSecretRevealStore`, etc.

All P1 gated. Keep code; don't mount consumers in P0.

---

## 4. Test infrastructure changes

### New dirs

```
packages/ui/src/__tests__/integration/   # RTL mounts of real engine + SessionInputSurface
packages/ui/src/__tests__/compat/         # golden-stream replay tests
packages/ui/src/__tests__/perf/           # budget harness
packages/ui/src/__tests__/p1-block-ux/    # block UX tests, flag-gated
fixtures/compat/                           # recorded byte streams + checkpoints
```

### Vitest config additions

- New test match pattern: `**/__tests__/{integration,compat,perf,p1-block-ux}/**/*.test.*`.
- Perf tests run via separate `pnpm test:perf` script so they don't slow unit CI.
- Compat tests run via `pnpm test:compat`.

### CI workflow

- `ui-unit.yml`: current, unchanged target is `test` (unit + integration).
- `compat.yml` (new): runs `pnpm test:compat` on macOS + Linux.
- `perf.yml` (new): runs `pnpm test:perf` on a single fixed runner class; budgets enforced.
- `grep-rules.yml`: adds `one-render-path`, `one-input-path`, `no-block-chunks-in-render`.

---

## 5. CI grep rules (new)

Rules live in `tools/check-*`:

### `tools/check-one-render-path/`

```
Rejects any production file (non-test, non-P1-gate) that imports:
  - AnsiParser, AnsiOutput
  - from 'react-dom' renderString
  - OR directly writes character glyphs via innerText/innerHTML
outside of:
  - packages/ui/src/shared/ui/cell-renderer/**
  - packages/ui/src/shared/lib/ansi-parser/** (the module itself)
  - anything under __tests__/p1-block-ux/
```

### `tools/check-one-input-path/`

```
Rejects any file outside features/input/ AND outside features/session/SessionInputSurface.tsx
that calls:
  - bridge.write
  - connection.write
  - sessionConnection.write

Allowed exception: features/input/* (the encoder layer itself).
```

### `tools/check-no-block-chunks-in-render/`

```
Rejects any import from entities/block/selectors that exposes `outputChunks`
outside of __tests__/p1-block-ux/ and the P1-flagged widgets.
```

---

## 6. Release / rollout order

- Phase 1 (Epic α + γ + ε scaffolding): land engine + batcher + compat harness. No user-facing change yet — P0 default UI still renders block cards (legacy).
- Phase 2 (Epic β): mount `SessionInputSurface` alongside existing block UI. Both exist; keystrokes route through new surface. User-visible: Ctrl+C works now.
- Phase 3 (Epic δ): flip `flag.blockUx` default to `false`. BlockList / Composer unmount. Plain grid terminal. ← this is P0's observable ship moment.
- Phase 4 (compat ε): fill in remaining compat fixtures until §1 matrix all-green.
- Phase 5: announce P0.

No intermediate "half-unified" user-facing state.

---

## 7. Checklist for each P1-gated widget

When moving a widget behind `flag.blockUx`:

- [ ] Wrap consumer mount points in `useFeatureFlag('blockUx') ? <Widget/> : null`.
- [ ] If the widget subscribes to `useBlockStore`: unchanged; the store is dormant in P0, subscriptions are cheap.
- [ ] If the widget writes to `bridge.write` directly: refactor to emit keystrokes via `input-host.synthesize` so the byte path stays unified.
- [ ] Tests: mark the test file with a `setup` that enables `flag.blockUx` before rendering.
- [ ] Mark test dir: move to `__tests__/p1-block-ux/` if whole file is block-UX.

---

## 8. Deletion policy

Deletion of `TuiInputSurface` / `TuiRenderSurface` / `composer` / `block-card` happens only AFTER:

- All migrated tests are green.
- No imports remain (CI grep).
- One release cycle under `flag.blockUx=false` default, no regressions reported.

Until then, code stays but unmounted. Avoids premature deletion + churn.
