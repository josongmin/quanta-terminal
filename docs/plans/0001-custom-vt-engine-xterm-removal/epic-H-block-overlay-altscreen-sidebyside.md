# EPIC-H — Block Overlay + Alt-screen UX + Side-by-side — Detailed Design

- **Status**: Design-ahead draft (Gear 3)
- **Date**: 2026-04-19
- **Scope owner**: EPIC-H spec agent
- **Phase**: 5
- **Duration**: ~1 week (5 working days)
- **Implements**: RFC 0001 §7.7 (alt-screen UX), §11 (selection), §13.11
  (side-by-side diff), §13.5 (renderer requirements for cursor/IME layers
  as they intersect alt-screen chrome), §18 (cross-renderer equivalence),
  §19 (final gate feeds), §20 (degraded mode), §22 #8 and §22 #17
  (explicit failure-mode retirement).
- **Depends on**: EPIC-D (`TerminalCanvas`, renderer backend contract,
  `cellToScreen` / `screenToCell`), EPIC-E (input encoder + IME state
  machine + mode snapshot), EPIC-F (session actor → event stream), EPIC-G
  (compat matrix — consumed by side-by-side harness).
- **Freezes**: side-by-side `data-renderer` flag contract, degraded-mode
  banner copy strings (additions to the ADR 0010 localization table),
  alt-screen transition timing constants, nested-depth-counter API for
  UI consumers.
- **Out-of-scope**: xterm removal (EPIC-I — Phase 6), new renderer
  backends (RFC 0002), sixel/kitty graphics (RFC 0003).

This document produces the component layout, state transitions, test
plan, and degraded-mode UX contract implementation that EPIC-H
implementation will code against. Target packages are `packages/ui`
only; no Rust under `crates/` is touched.

---

## 1. Summary

**Goal**: Replace block-entity virtualization with row-range
virtualization; anchor block chrome via `cellToScreen`; collapse chrome
to a thin status line on alt-screen enter / re-expand on exit; ship
a developer-only side-by-side harness that runs canvas + xterm on the
same event stream and surfaces cell-level diffs; implement the §20
degraded-mode contract (last-frame-preserved banner + disabled input +
observable recovery path). These four sub-deliverables are bundled
because they all touch `TerminalPage.tsx` and the `BlockList` surface
and because shipping them piecemeal would leave the UI in half-migrated
states.

**Phase**: 5. **Duration**: ~1 week.

**Dependencies**: D + E + F + G. The side-by-side harness consumes G's
compat matrix; the degraded-mode banner reuses D's cursor/overlay
layering primitives; the block chrome reuses D's `cellToScreen`.

**Contracts frozen here**:

- `data-renderer="canvas"|"xterm"` attribute on the app root; runtime
  toggle via settings panel (dev-mode only); default pinned by
  `preferences.renderer`.
- Alt-screen transition timing: 160 ms fade, configurable via
  `preferences.altScreenTransition: 'instant' | 'fade'`.
- Degraded-mode banner copy rows added to the ADR 0010 localization
  table.
- Nested-alt-screen depth counter API: `ModeChanged(AltScreen, Nested
  { depth: u8 })` is surfaced to the UI via the `GridMirror`.

## 2. Background

### 2.1 What RFC §7.7 says

RFC §7.7 is a table:

| Transition | UI response | Timing |
|------------|-------------|--------|
| DECSET 1049 enter | Chrome collapses to status line | 160 ms fade |
| DECSET 1049 exit | Chrome re-expands, scrollback re-renders | 160 ms fade |
| Nested enter (e.g. vim inside tmux) | Depth counter increments; only outermost transition is UX-visible | immediate |
| Alt crash (PTY close mid-alt) | Status line shows error; 2 s hold; ghost frame dismissed | 2 s |

Today the UI has `tuiActive`, `needsAltScreen`, `altScreenVisible`
boolean-ish flags scattered across `TerminalPage.tsx`,
`terminal-shell/alt-screen-stream.ts`, and the `entities/tui/model.ts`
store. These flags were aligned to xterm's alt-screen detection and
must be replaced with engine-sourced `ModeChanged(AltScreen, …)`
events.

### 2.2 What RFC §13.11 says

Side-by-side is the final pre-removal gate:

- `data-renderer="canvas"|"xterm"` dev flag.
- Both consume the same PTY stream simultaneously.
- Harness diffs cells / cursor / mode / encoded input bytes.

This is the gate that feeds the §19 line "xterm vs canvas diff = 0
across matrix."

### 2.3 What RFC §20 + ADR 0010 say

ADR 0010 defines the degraded-mode UI contract — truth-state taxonomy,
badges, tooltips, banners. RFC §20 is a specific instance: engine
crash → last consistent snapshot remains visible, read-only, with a
banner; no black screen; recovery path observable + logged.

EPIC-H is where the ADR 0010 primitives (banner, badge) are wired to
the specific engine-death condition RFC §20 describes.

### 2.4 Why all four ship together

- Row-range virtualization and chrome-from-ModeChanged both need
  `TerminalPage.tsx` rewrites. Splitting into two PRs means the
  intermediate state has neither chrome nor correct virtualization.
- Side-by-side depends on canvas being mounted alongside xterm; the
  `data-renderer` flag is the simplest way to get both surfaces into
  the same DOM tree, which also requires `TerminalPage.tsx` changes.
- Degraded-mode banner needs a stable render root that survives
  engine death. That root is TerminalPage. One rewrite pass.

## 3. Scope

### 3.1 Files (modified)

- `packages/ui/src/widgets/block-list/BlockList.tsx` —
  switch from block-entity virtualization to row-range virtualization
  anchored via `cellToScreen`. Major rewrite.
- `packages/ui/src/widgets/block-list/block-list.module.css` — update
  chrome positioning rules for absolute anchoring.
- `packages/ui/src/widgets/block-list/__tests__/BlockList.test.tsx` —
  regenerate tests around the new virtualization model.
- `packages/ui/src/widgets/block-card/BlockCard.tsx` — alt-screen
  chrome collapse (thin status line) + re-expand.
- `packages/ui/src/widgets/block-card/block-card.module.css` — CSS
  transitions for 160 ms fade, `prefers-reduced-motion` honored.
- `packages/ui/src/widgets/block-card/__tests__/BlockCard.test.tsx` —
  add tests for collapse transitions.
- `packages/ui/src/pages/terminal-page/TerminalPage.tsx` — mount
  `TerminalCanvas` (from EPIC-D); wire `data-renderer`; consume
  `ModeChanged` events; remove `tuiActive` / `needsAltScreen` /
  `altScreenVisible` branching.
- `packages/ui/src/pages/terminal-page/terminal-page.module.css` —
  remove alt-screen-container styles that conflict with row-range
  virtualization.
- `packages/ui/src/pages/terminal-page/__tests__/TerminalPage.test.tsx`
  — update to reflect new component tree.
- `packages/ui/src/entities/tui/model.ts` — convert store to drive
  from `ModeChanged`; may become a thin wrapper or be removed.
- `packages/ui/src/entities/tui/__tests__/model.test.ts` — update or
  delete per above.
- `packages/ui/src/entities/tui/index.ts` — adjust exports.
- `packages/host-common/src/events.ts` — mirror the nested-alt-screen
  depth variant shape.
- `packages/ui/src/features/settings/` (existing settings panel) —
  add `preferences.altScreenTransition` toggle row and
  `preferences.renderer` dev-only toggle row.

### 3.2 Files (new)

- `packages/ui/src/features/compat/SideBySideHarness.tsx` — dev-mode
  overlay; mounts canvas + xterm side by side; reports diffs.
- `packages/ui/src/features/compat/side-by-side-diff.ts` — pure
  function: `(canvasState, xtermState) → CellDiff[] | CursorDiff |
  ModeDiff | InputByteDiff[]`.
- `packages/ui/src/features/compat/side-by-side-recorder.ts` — ring
  buffer for diffs; export-on-request.
- `packages/ui/src/features/compat/__tests__/side-by-side-diff.test.ts`
  — unit tests for the diff function.
- `packages/ui/src/features/compat/__tests__/side-by-side.test.tsx` —
  component tests for the harness.
- `packages/ui/src/features/compat/index.ts` — public exports.
- `packages/ui/src/features/degraded-mode/DegradedBanner.tsx` — banner
  component per ADR 0010; specific to engine-death case.
- `packages/ui/src/features/degraded-mode/useDegradedMode.ts` — hook
  that subscribes to engine-liveness signals, exposes `{ state:
  'healthy' | 'degraded', lastSnapshotAt: number, reason: string }`.
- `packages/ui/src/features/degraded-mode/degraded-banner.module.css`.
- `packages/ui/src/features/degraded-mode/index.ts`.
- `packages/ui/src/features/degraded-mode/__tests__/DegradedBanner.test.tsx`.
- `packages/ui/src/features/degraded-mode/__tests__/useDegradedMode.test.ts`.
- `packages/ui/src/widgets/alt-screen-status/AltScreenStatusBar.tsx` —
  the thin status line that replaces chrome during alt-screen.
- `packages/ui/src/widgets/alt-screen-status/alt-screen-status.module.css`.
- `packages/ui/src/widgets/alt-screen-status/index.ts`.
- `packages/ui/src/widgets/alt-screen-status/__tests__/AltScreenStatusBar.test.tsx`.

### 3.3 Files (deleted or deprecated)

- `packages/ui/src/widgets/terminal-shell/alt-screen-stream.ts` — no
  longer consulted; logic is replaced by `ModeChanged` subscription.
  NOT deleted in this epic (EPIC-I owns removal); marked deprecated
  with `@deprecated` JSDoc.
- `packages/ui/src/widgets/terminal-shell/__tests__/alt-screen-stream.test.ts`
  — marked skipped; removed in EPIC-I.

### 3.4 Out of scope

- Deleting `packages/ui/src/widgets/terminal-shell/` — EPIC-I.
- Removing `@xterm/*` dependencies — EPIC-I.
- Perf-harness instrumentation of the new components — EPIC-J.
- CI jobs for the new tests — EPIC-K (owns `.github/workflows/*`).
- Glyph atlas / FontAtlas rework beyond what EPIC-D already landed.
- WebGL/WebGPU backend switch — RFC 0002.

## 4. Design

### 4.1 Row-range virtualization in `BlockList`

Today `BlockList` virtualizes over a `blocks: Block[]` array where
each block is the unit. That model assumes blocks are vertically
stacked and each block has a fixed or measurable height. It breaks
when the underlying grid is one long scrollback: selection across
blocks misaligns, scrollback replay produces N mounts rather than one
scroll, and the cell grid and block chrome drift.

**New model**: the block list is authoritatively a row-range index.

```ts
type RowRange = {
  blockId: BlockId;
  startRow: number; // inclusive, in grid row coordinates
  endRow: number;   // exclusive
};

type BlockListState = {
  ranges: RowRange[];         // contiguous; sorted by startRow
  totalRows: number;          // = scrollback.length + mainBuffer.rows
};
```

`useVirtualizer` (tanstack-virtual) operates on `totalRows`. It returns
the visible row indices; we map those back to the owning `RowRange`
via a binary search (`ranges` is sorted). Each range rendered on
screen wraps its block chrome (header, status, buttons) as an
**absolutely-positioned overlay** anchored via `cellToScreen(startRow,
0)` for top-left and `cellToScreen(endRow - 1, cols - 1)` for
bottom-right. The cell grid beneath (rendered by `TerminalCanvas`)
has priority for pixel correctness; block chrome sits on top.

#### 4.1.1 Why absolute positioning

Because `TerminalCanvas` owns pixel placement of cells. Block chrome
must never shift cells. The only way to guarantee that is to lift
block chrome into a separate stacking layer that reads from the same
`cellToScreen` function the renderer uses.

#### 4.1.2 Selection / hit-test

`BlockList` no longer intercepts mouse events for block chrome on the
cell-grid area. The cell area is owned by `TerminalCanvas`'s hit-test
(`screenToCell`). Block chrome (header / buttons) owns mouse events
ONLY on its own absolutely-positioned region.

#### 4.1.3 Scrollback interaction

The virtualizer is given `scrollbackRows + mainBufferRows` as total.
On `GridDelta` arrival, `totalRows` may increase (new scrollback row
promoted from main buffer on line feed). `useVirtualizer` is informed
via its imperative API.

#### 4.1.4 Alt-screen case

When alt-screen is active, `totalRows = altBufferRows` (24 by default,
no scrollback). The `ranges` array is a single virtual range spanning
the whole alt buffer with a placeholder `blockId: 'alt'`; block
chrome for that range is the `AltScreenStatusBar` instead of
`BlockCard`.

### 4.2 Alt-screen chrome collapse (`BlockCard` + `AltScreenStatusBar`)

Transitions per RFC §7.7 table. State machine:

```
 Normal ─── DECSET 1049 enter ──▶ Collapsing (160 ms) ──▶ Collapsed
  ▲                                                              │
  │                                                              │
  └──── DECSET 1049 exit ◀─── Expanding (160 ms) ◀─────────────── ┘
                                                                  │
                                                              nested enter ──▶ depth++
                                                                  │
                                                              nested exit ──▶ depth--
```

- `Collapsing` (160 ms): `BlockCard` chrome animates out (buttons fade
  out, padding collapses). `AltScreenStatusBar` fades in with text
  `{command} · {session} · Ctrl-D to exit` (or equivalent per ADR
  0010 copy-discipline rules).
- `Collapsed`: `AltScreenStatusBar` is the only UI visible above the
  cell grid. Cell grid switches to alt buffer (this happens at the
  engine level; `GridMirror` applies the alt-buffer deltas).
  Scrollback is hidden visually (the `BlockList` above the alt-active
  block is `display: none` during Collapsed state).
- `Expanding` (160 ms): the reverse.
- `Normal`: chrome fully visible; cell grid is main buffer.

**Nested alt-screen**: when the engine emits `ModeChanged(AltScreen,
Nested { depth: 2 })`, the UI does NOT re-animate. The status bar
updates its label (e.g., from `tmux · compat-session` to `vim in
tmux · compat-session`) without transition. Depth counter is tracked
in `entities/tui/model.ts`.

**Alt-screen crash**: `ModeChanged(AltScreen, Crashed { reason })`
(engine emits this when the PTY closes while alt is active). Status
bar shows `{command} exited with signal {sig}`; 2 s hold; then
chrome re-expands to Normal with the last main-buffer frame visible.
The 2 s ghost frame is a read-only display of the last alt-buffer
state (rendered from `GridMirror`'s cached alt snapshot).

**Timing constants**:

```ts
const ALT_SCREEN_TRANSITION_MS = 160; // RFC §7.7
const ALT_SCREEN_GHOST_HOLD_MS = 2000; // RFC §7.7 "alt crash" row
```

Both are pulled from `preferences.altScreenTransition`:

- `'fade'` (default): use the constants above.
- `'instant'`: 0 ms transition; ghost hold still 2 s for crash.
- `prefers-reduced-motion: reduce` OS-level → behave as `'instant'`
  regardless of preference.

### 4.3 Side-by-side harness (`SideBySideHarness` + `side-by-side-diff`)

Mount both renderers when `preferences.renderer === 'side-by-side'`
(dev-only; hidden from production build via `if (import.meta.env.DEV)`).

Layout:

```
+---------------------+---------------------+
|  canvas renderer    |  xterm renderer     |
|  (TerminalCanvas)   |  (TerminalShell)    |
|                     |                     |
+---------------------+---------------------+
|              cell-diff overlay              |
|  [row 5 col 12 — canvas: "가" w=2 /         |
|                  xterm: "가" w=1]           |
+---------------------------------------------+
```

Both renderers receive the **same event stream** (sourced from
`GridMirror`). Not a forked stream — a multicast. Both must apply the
same deltas.

#### 4.3.1 Diff algorithm

`side-by-side-diff.ts` exports:

```ts
type CellDiff = {
  kind: 'cell';
  row: number;
  col: number;
  canvas: CellSnapshot;
  xterm: CellSnapshot;
};

type CursorDiff = { kind: 'cursor'; canvas: CursorState; xterm: CursorState };
type ModeDiff = { kind: 'mode'; mode: string; canvas: unknown; xterm: unknown };
type InputByteDiff = { kind: 'input'; at: number; canvasBytes: Uint8Array; xtermBytes: Uint8Array };
type Diff = CellDiff | CursorDiff | ModeDiff | InputByteDiff;

export function diffFrames(canvas: FrameSnapshot, xterm: FrameSnapshot): Diff[];
```

The diff runs on a schedule:

- Every N frames (default N = 10 — configurable via
  `preferences.sideBySideDiffIntervalFrames`).
- Also on-demand via a dev-tools button (`Export diff now`).

#### 4.3.2 Ring buffer

`side-by-side-recorder.ts` holds a ring of the last 256 diff snapshots
(each snapshot = the diff at a given frame). On export, it serializes
the ring to JSON and downloads. This surfaces intermittent divergences
that would be lost in a live overlay.

#### 4.3.3 Input byte diff

The input encoder (EPIC-E) emits bytes. In side-by-side mode, the
harness wraps the encoder call: bytes go to both paths. xterm-side
input is captured post-encode via a `window.__XTERM_INPUT_TAP__`
hook (installed in dev mode only). Divergence in encoded bytes
surfaces as `InputByteDiff`.

#### 4.3.4 Production build

`SideBySideHarness.tsx` is tree-shaken from production builds via
`import.meta.env.DEV` guard. Verified by a CI size-budget check: if
`side-by-side-*` modules appear in the production chunk, the build
fails.

### 4.4 Degraded-mode contract implementation

Per ADR 0010 (§Banner Triggers) + RFC §20.

#### 4.4.1 Engine-liveness signal

The session actor (EPIC-F) exposes a liveness stream. `useDegradedMode`
subscribes:

- `healthy` — events arriving normally; sequence gaps < 500 ms.
- `stalled` — no event for > 1 s; no diagnosis yet.
- `degraded` — liveness ping fails (engine process gone, socket closed,
  or host-host bridge reports sidecar-crash per ADR 0004).

Only `degraded` triggers the banner. `stalled` is a local UI state
(shows a subtle "waiting…" hint, not a banner; banner would be too
loud for transient network hiccups).

#### 4.4.2 Last-snapshot preservation

When `state` flips to `degraded`, `GridMirror` is frozen (no further
deltas accepted; any arriving after the flip are queued pending
recovery). The last-applied `GridSnapshot` remains rendered. No
black screen. Cursor is rendered but not blinking (static).

#### 4.4.3 Banner

`DegradedBanner.tsx` renders when `state === 'degraded'`:

- Copy (added to ADR 0010 localization table): `Engine crashed; last
  frame preserved. Restart session to continue.`
- Primary action: `Restart session` button → triggers session restart
  via session actor IPC.
- Dismiss: none. The banner is dismissed ONLY by a successful session
  restart. This is stricter than ADR 0010's default banner contract
  (which allows dismissal) because the condition is "engine dead";
  dismissing the banner while engine is still dead would produce the
  black-screen failure mode RFC §20 forbids.
- Single-line; no stacking (ADR 0010 precedence: crash > quota >
  secret > shell integration).

#### 4.4.4 Input handling

While `state === 'degraded'`:

- Key events: intercepted at `TerminalPage` level, dropped, and a
  telemetry counter `degraded.dropped_input_count` increments.
- Mouse: pointer events on cell grid are no-op; only the banner's
  `Restart session` button is interactive.
- IME: any active composition is cancelled (per EPIC-E rule; blur
  during composition → cancel on macOS, preserve on Win/Linux, but
  engine-death supersedes platform rule — always cancel).

#### 4.4.5 Recovery

On `Restart session` click:

- Session actor is re-launched.
- New `grid_epoch` assigned; full `GridSnapshot` re-seeded.
- `GridMirror` unfreezes.
- `state` flips back to `healthy`; banner disappears (no animation —
  instant swap; the user's intent was to see a fresh session).
- Telemetry counter `degraded.recoveries` increments.

### 4.5 `ModeChanged` as the single source of truth for alt-screen state

Today the UI has three flags:

- `tuiActive` — derived from xterm's `Terminal.onTitleChange` +
  heuristic.
- `needsAltScreen` — a pessimistic hint from block parser.
- `altScreenVisible` — whether xterm's alt-screen layer is on DOM.

All three go away. New source: `ModeChanged(AltScreen, payload)` where
payload is:

```ts
type AltScreenPayload =
  | { active: false }
  | { active: true; depth: 1 }                // outermost program
  | { active: true; depth: N > 1 }            // nested
  | { active: false; crashed: { reason: string } };  // crash exit
```

This is exposed by `GridMirror` via `getMode('AltScreen')` and by a
React hook `useAltScreenMode()`. `entities/tui/model.ts` becomes a
thin derivation: `tuiActive = altScreen.active`,
`altScreenDepth = altScreen.depth ?? 0`.

CI rule (EPIC-K owns): `grep -r "tuiActive\|needsAltScreen\|altScreenVisible"
packages/ui/src/` outside `entities/tui/model.ts` and deprecated
`terminal-shell/` returns zero after this epic.

### 4.6 Settings panel additions

Two new rows:

| Setting | Values | Default | Scope |
|---------|--------|---------|-------|
| `preferences.altScreenTransition` | `'instant' \| 'fade'` | `'fade'` | Per-user |
| `preferences.renderer` | `'canvas' \| 'xterm' \| 'side-by-side'` | `'canvas'` (dev) / `'xterm'` (until §19 gate) | Per-user; `'side-by-side'` visible only in DEV builds |

Settings panel picks up these rows via its existing preference schema;
no new UI primitive.

## 5. Definition of Done (≥ 30 items)

### 5.1 Row-range virtualization

- [ ] `BlockList` virtualizes row ranges, not block entities (verified
      by source review and a `grep "blocks.map"` absence check).
- [ ] `BlockListState.ranges` is a sorted, contiguous array backed by
      a binary-search lookup.
- [ ] `useVirtualizer` total-row count == `scrollback.length +
      mainBuffer.rows` (verified by unit test).
- [ ] Block chrome is anchored via `cellToScreen(startRow, 0)`
      (verified by a visual test: block header Y-coordinate matches
      `cellToScreen` output ±1 px).
- [ ] Selection across block boundaries in the cell grid is handled
      by `TerminalCanvas`'s `screenToCell`; `BlockList` does NOT
      intercept cell-area mouse events (verified by `pointer-events:
      none` on cell-area wrapper).
- [ ] Scrollback promotion (row moves from main → scrollback) updates
      `totalRows` within one frame (verified by unit test).

### 5.2 Alt-screen transitions

- [ ] DECSET 1049 enter → chrome collapses to status line within 160 ms
      (measured via `performance.now()` in E2E-H1).
- [ ] DECSET 1049 exit → chrome re-expands within 160 ms (E2E-H2).
- [ ] Nested alt-screen (tmux + vim) tracks depth counter
      `{ active: true, depth: 2 }` (verified in E2E-H3).
- [ ] `ModeChanged(AltScreen, true)` arrives before first alt-buffer
      cell delta (verified end-to-end via scripted scenario and
      asserted in `GridMirror` ordering test).
- [ ] Alt-screen crash → status line shows exit reason; 2 s ghost
      hold; chrome re-expands (E2E-H4).
- [ ] `preferences.altScreenTransition === 'instant'` → 0 ms
      transition (verified by unit test reading animation duration).
- [ ] `prefers-reduced-motion: reduce` → instant regardless of
      preference (verified via media query test).
- [ ] `AltScreenStatusBar` is a single row, never stacks with
      `BlockCard` chrome.

### 5.3 Side-by-side harness

- [ ] `data-renderer="canvas"` flips the active renderer.
- [ ] `data-renderer="side-by-side"` mounts both renderers
      simultaneously in dev mode (verified by DOM assertion).
- [ ] Both renderers consume the same event stream (verified via
      spy on `GridMirror.apply`).
- [ ] `side-by-side-diff.ts` produces zero diffs for every MUST compat
      scenario fed from EPIC-G fixtures (E2E-H6, E2E-H7).
- [ ] `SideBySideHarness` is tree-shaken from production builds
      (verified by build-size CI job).
- [ ] Ring buffer holds last 256 diff snapshots; export-on-request
      downloads JSON.
- [ ] Input byte diff surfaces when canvas + xterm encode differently
      (verified by a forced-divergence unit test).

### 5.4 Degraded mode

- [ ] `kill -9 quanta-core` → banner shown within 500 ms (E2E-H8).
- [ ] Last `GridSnapshot` preserved; no black screen (E2E-H8).
- [ ] Banner dismissible ONLY by successful session restart (E2E-H10).
- [ ] Input dropped while degraded; telemetry
      `degraded.dropped_input_count` increments (E2E-H9).
- [ ] `degraded.recoveries` counter increments on successful restart.
- [ ] IME composition cancelled on transition to degraded (verified
      by unit test on `useDegradedMode` + `ImeStateMachine`).
- [ ] Banner copy uses ADR 0010 localization table; no hard-coded
      strings.

### 5.5 `ModeChanged` single-source-of-truth

- [ ] No `tuiActive` / `needsAltScreen` / `altScreenVisible` branching
      in `TerminalPage.tsx` (CI grep rule).
- [ ] `entities/tui/model.ts` derives state ONLY from `ModeChanged`
      events (verified by source review).
- [ ] `useAltScreenMode()` hook exposed; consumed by `BlockCard` and
      `AltScreenStatusBar`.

### 5.6 Housekeeping / quality

- [ ] `pnpm --filter @quanta/ui test` green.
- [ ] `pnpm --filter @quanta/ui lint` clean (including new grep rules
      in EPIC-K).
- [ ] Settings panel wires `preferences.altScreenTransition` and
      `preferences.renderer` rows.
- [ ] ADR 0010 localization table has new rows for degraded-mode
      banner copy; PR reviewer sign-off per ADR 0010 §Copy Discipline.
- [ ] `terminal-shell/alt-screen-stream.ts` carries `@deprecated`
      JSDoc and is scheduled for deletion in EPIC-I.

**Total DoD items**: 32 (6 + 8 + 7 + 7 + 3 + 5 = 36; de-duplicated to 32 unique items).

## 6. Quality Gates

| Gate | Check | Failure action |
|------|-------|----------------|
| **Chrome-anchoring correctness** | Visual test: block header top-Y matches `cellToScreen(startRow, 0).y` ±1 px | Fix `cellToScreen` call or DOM positioning |
| **Alt-screen transition timing** | E2E-H1 + E2E-H2: measured duration within [140, 180] ms for 'fade' | Adjust CSS transition or animation frame alignment |
| **Nested depth correctness** | E2E-H3: depth == 2 during `vim` inside `tmux` | Fix engine depth counter or UI subscription |
| **Side-by-side parity** | E2E-H6, E2E-H7: diff = 0 cells across all MUST compat scenarios | Treat as P0 bug; likely engine divergence from xterm baseline |
| **Degraded-mode latency** | E2E-H8: banner appears ≤ 500 ms after engine death | Fix liveness polling interval |
| **No-black-screen invariant** | E2E-H8: last snapshot visible throughout degraded state | Fix `GridMirror` freeze logic |
| **Input disabled while degraded** | E2E-H9: every attempted key during degraded state is dropped + counted | Fix `TerminalPage` key intercept |
| **CI grep: no legacy alt-screen flags** | `tuiActive\|needsAltScreen\|altScreenVisible` outside allowlist = 0 matches | Block merge |
| **Production bundle size** | `SideBySideHarness` absent from production chunk | Add `import.meta.env.DEV` guard |
| **ADR 0010 copy compliance** | Banner strings in localization table, not hard-coded | Move strings to table |
| **Reduced-motion compliance** | CSS honors `prefers-reduced-motion: reduce` | Update CSS media query |

## 7. E2E scenarios (10+)

Each assertion is executable; step counts 5-15; expected durations
measurable.

### E2E-H1 — Alt-screen enter, chrome collapse

1. Precondition: session healthy; cell grid at main buffer; `BlockCard`
   chrome visible.
2. Start timer `t0 = performance.now()`.
3. Engine emits `ModeChanged(AltScreen, { active: true, depth: 1 })`.
4. Wait for `AltScreenStatusBar` to be fully visible (opacity = 1).
5. Record `t1 = performance.now()`.
6. Assert `t1 - t0 ∈ [140, 180]` ms when transition = 'fade'.
7. Assert `BlockCard` chrome has `display: none` or `opacity: 0`.
8. Assert `AltScreenStatusBar` contains `{command} · {session}`.

### E2E-H2 — Alt-screen exit, chrome re-expand

1. Precondition: alt-screen active; status bar visible.
2. Start timer `t0`.
3. Engine emits `ModeChanged(AltScreen, { active: false })`.
4. Wait for `BlockCard` chrome to be fully visible.
5. Record `t1`.
6. Assert `t1 - t0 ∈ [140, 180]` ms.
7. Assert scrollback re-rendered (BlockList's `ranges` length > 0 and
   first range visible).
8. Assert cursor returns to main-buffer position.

### E2E-H3 — Nested alt-screen (tmux + vim)

1. Spawn `tmux new-session -s e2e-h3` under scripted runner.
2. Assert `ModeChanged(AltScreen, { active: true, depth: 1 })`.
3. Assert `AltScreenStatusBar` text contains `tmux`.
4. Send `vim /tmp/e2e-h3.txt\n`.
5. Assert `ModeChanged(AltScreen, { active: true, depth: 2 })`.
6. Assert `AltScreenStatusBar` text updates to `vim in tmux` (no
   re-animation; CSS transition duration 0 for depth transitions).
7. Send `:q!\n`.
8. Assert `ModeChanged(AltScreen, { active: true, depth: 1 })`.
9. Assert `AltScreenStatusBar` text back to `tmux`.
10. Send `\x02d` (tmux detach).
11. Assert `ModeChanged(AltScreen, { active: false })`.
12. Assert chrome re-expanded.

### E2E-H4 — Alt-screen program crash

1. Spawn `vim` under scripted runner; assert alt-screen entered.
2. Externally `kill -9` the vim process.
3. Engine emits `ModeChanged(AltScreen, { active: false, crashed: {
   reason: "signal 9" } })`.
4. Assert `AltScreenStatusBar` text shows `vim exited with signal 9`.
5. Wait 2 s.
6. Assert chrome re-expands.
7. Assert last main-buffer frame is visible (pre-alt content).
8. No banner shown (banner is engine-death; this is program-death —
   different condition).

### E2E-H5 — Resize during alt-screen

1. Enter alt-screen via `vim`.
2. Resize terminal from 80×24 to 120×40.
3. Assert `AltScreenStatusBar` stays visible (not hidden mid-resize).
4. Assert cell grid resizes within 1 frame.
5. Assert `resize_generation` increments in `GridMirror`.
6. Exit vim (`:q!`).
7. Assert scrollback reflows correctly at 120 cols.

### E2E-H6 — Side-by-side vim

1. Set `preferences.renderer = 'side-by-side'` in dev mode.
2. Spawn `vim --clean /tmp/sxs.txt`.
3. Let vim run for 10 s under idle cursor blink.
4. Assert `diffFrames()` returns zero `CellDiff` entries.
5. Assert zero `CursorDiff`.
6. Assert zero `ModeDiff`.
7. Assert ring buffer has ~60 diff snapshots, all zero-diff.
8. Send `i hello\x1b:wq\n`.
9. Assert still zero diffs post-edit and post-exit.

### E2E-H7 — Side-by-side tmux with split

1. Set side-by-side mode.
2. Spawn `tmux new-session \; split-window`.
3. Assert zero `CellDiff` for full runtime.
4. Send a bursty output (`yes | head -1000\n`) into one pane.
5. Assert zero `CellDiff` throughout burst.
6. Tear down tmux.

### E2E-H8 — Engine crash → banner

1. Session healthy; vim running.
2. Externally `kill -9 quanta-core` (the engine sidecar).
3. Start timer `t0`.
4. Liveness detector flips to `degraded` within 500 ms.
5. Record `t1 = banner visible`.
6. Assert `t1 - t0 ≤ 500` ms.
7. Assert last `GridSnapshot` still rendered (cell grid not blank).
8. Assert cursor visible but not blinking.
9. Assert banner text matches ADR 0010 localization row for
   engine-crash.
10. Assert banner has only one action: `Restart session`.

### E2E-H9 — Degraded-mode input handling

1. Trigger degraded state (as E2E-H8).
2. Record `degraded.dropped_input_count` pre-keystroke.
3. Send a keystroke (`a`).
4. Assert key does NOT reach engine (engine is dead anyway).
5. Assert counter `degraded.dropped_input_count` incremented by 1.
6. Send another keystroke (`b`).
7. Assert counter incremented by 1 (total +2).
8. Move mouse; assert no mouse event reaches cell grid.
9. Attempt to focus an IME; assert composition is cancelled (not
   started).

### E2E-H10 — Degraded-mode recovery

1. Continue from E2E-H9 (state = degraded).
2. Click `Restart session` in banner.
3. Session actor re-launched (IPC call).
4. New `grid_epoch` assigned by engine.
5. `GridMirror` unfreezes; receives fresh `GridSnapshot`.
6. Assert banner disappears within 1 frame.
7. Assert chrome re-renders with fresh block list.
8. Assert cursor blinks again.
9. Assert `degraded.recoveries` counter incremented by 1.
10. Send a keystroke; assert it reaches engine (verified via
    round-trip event).

### E2E-H11 — CI grep for legacy flags

Not a runtime E2E but a build-time gate:

1. CI runs `grep -r "tuiActive\|needsAltScreen\|altScreenVisible"
   packages/ui/src/`.
2. Excludes `entities/tui/model.ts` (allowed to reference for
   derivation) and `widgets/terminal-shell/` (deprecated, removed in
   EPIC-I).
3. Assert zero remaining matches.
4. If matches exist, build fails with log pointing at the file/line.

### E2E-H12 — Reduced motion

1. Set OS-level `prefers-reduced-motion: reduce`.
2. Trigger alt-screen enter.
3. Assert transition is instant (0 ms) regardless of
   `preferences.altScreenTransition = 'fade'`.
4. Trigger alt-screen exit; same assertion.

## 8. Test deliverables

| Deliverable | File | Tests |
|-------------|------|-------|
| BlockList row-range tests | `widgets/block-list/__tests__/BlockList.test.tsx` | ≥ 10 |
| BlockCard collapse/expand tests | `widgets/block-card/__tests__/BlockCard.test.tsx` | ≥ 6 |
| AltScreenStatusBar tests | `widgets/alt-screen-status/__tests__/AltScreenStatusBar.test.tsx` | ≥ 4 |
| TerminalPage integration tests | `pages/terminal-page/__tests__/TerminalPage.test.tsx` | ≥ 8 |
| Side-by-side harness tests | `features/compat/__tests__/side-by-side.test.tsx` | ≥ 6 |
| Side-by-side diff unit tests | `features/compat/__tests__/side-by-side-diff.test.ts` | ≥ 8 |
| DegradedBanner tests | `features/degraded-mode/__tests__/DegradedBanner.test.tsx` | ≥ 4 |
| useDegradedMode tests | `features/degraded-mode/__tests__/useDegradedMode.test.ts` | ≥ 5 |
| Entities/tui derivation tests | `entities/tui/__tests__/model.test.ts` | ≥ 5 |
| E2E scenarios | `tests/integration/tests/epic_h_*.rs` (or Playwright) | 12 |

Approximate total: 60+ new / updated unit-level tests + 12 E2E.

## 9. Failure modes retired

Explicit RFC §22 retirement:

- **§22 #8** — `1049 enter races first alt-frame → unformatted flash`.
  Retired by E2E-H1 ordering verification (`ModeChanged` before first
  alt-buffer cell delta). The engine guarantee (EPIC-B) is necessary;
  the UI guarantee (EPIC-H) closes it end-to-end.
- **§22 #17** — `Engine crash mid-alt-screen → black screen`. Retired
  by E2E-H8 (last snapshot preserved; banner visible within 500 ms).

Not retired here (tracked elsewhere):

- §22 #1-#4, #12-#14, #18 — input / IME (EPIC-E).
- §22 #5-#7 — width / grapheme (EPIC-A).
- §22 #9-#11 — cursor / resize / scrollback (EPIC-B).
- §22 #15-#16 — out-of-order / slow-link (EPIC-C + EPIC-J).
- §22 #19-#20 — font / selection (EPIC-D).

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `tanstack-virtual` row-range virtualization with variable-height rows | Medium | High | `estimateSize` + measure callback; fallback to fixed-height row mode + overflow; unit test covering both paths |
| Side-by-side in production = 2× memory | Certain if enabled | Medium | Gated behind `import.meta.env.DEV` + CI bundle-size check; setting hidden in production UI |
| Alt-screen ghost frame collides with renderer recycling | Medium | Medium | Explicit 2 s timer + `onAnimationEnd` callback; ghost frame has its own stacking context |
| `kill -9 quanta-core` detection depends on host-host bridge health | Medium | High | Liveness signal is sourced from multiple channels (event gap + bridge ping + ADR 0004 sidecar-crash event); any two trigger degraded state |
| Banner copy drifts from ADR 0010 table | Low | Low | CI lint rule: banner JSX must import strings from `localization/degraded.ts` |
| `data-renderer` attribute collides with xterm's addon initialization order | Medium | Medium | Both renderers mount lazily and independently; attribute is advisory for CSS; no addon re-init |
| Nested-depth counter off-by-one in UI (engine correct, UI wrong) | Medium | Medium | Single-source: `useAltScreenMode()` reads directly from `GridMirror.getMode('AltScreen')`; no local counter |
| Recovery race: restart button clicked twice | Low | Medium | Button disabled on click; re-enabled only on `state === 'healthy'` |
| IME cancellation during transition to degraded misses a composition in flight | Low | Low | `useDegradedMode` listens to IME state machine; cancellation is idempotent |
| `prefers-reduced-motion` respected in CSS but not in JS timers | Medium | Low | JS timers also check `window.matchMedia('(prefers-reduced-motion: reduce)')` |

## 11. Rollback

If side-by-side uncovers > 2 MUST compat gaps that can't be closed in
the week budget:

- Set `preferences.renderer` default to `'xterm'` (stays user-visible).
- Canvas stays behind `experimental.renderer = 'canvas'` flag.
- EPIC-H reports exit with "gate FALSE" status for RFC §19 line
  "xterm vs canvas diff = 0 across matrix."
- EPIC-I (xterm removal) does NOT start.
- `SideBySideHarness` remains in dev-builds as a debugging tool for
  the remaining gaps.

Degraded-mode banner and row-range virtualization are retained
regardless — they are value-add independent of the xterm-removal
decision. Only the side-by-side / canvas-default gate rolls back.

## 12. Cross-references

- **RFC 0001 §7.7** — alt-screen UX transitions table.
- **RFC 0001 §11** — selection semantics (row-range virtualization
  must preserve ADR 0016 selection behavior).
- **RFC 0001 §13.11** — side-by-side diff contract.
- **RFC 0001 §13.5** — renderer requirements (cursor + IME layer
  separation).
- **RFC 0001 §18** — cross-renderer equivalence.
- **RFC 0001 §19** — final removal gate: lines "xterm vs canvas diff
  = 0 across matrix", "Alt-screen enter/exit/nested OK", and
  "≥ 1 week dogfood clean" are all gated by EPIC-H.
- **RFC 0001 §20** — degraded-mode contract.
- **RFC 0001 §22 #8, #17** — failure modes retired here.
- **ADR 0010** — degraded-mode UI contract (banner, badge, localization
  discipline).
- **ADR 0014** — architecture invariants (features/widgets/entities
  layering).
- **ADR 0016** — selection / search / copy semantics (row-range
  virtualization must not break these).
- **ADR 0017** — event envelope + ordering; alt-screen transition
  ordering enforced end-to-end here.
- **EPIC-D** — `cellToScreen`, `TerminalCanvas`, renderer backend
  contract consumed by block chrome anchoring.
- **EPIC-E** — input encoder + IME; consumed for degraded-mode input
  handling and side-by-side input byte diff.
- **EPIC-F** — session actor liveness signal; consumed by
  `useDegradedMode`.
- **EPIC-G** — compat matrix fixtures feed side-by-side E2E scenarios.
- **EPIC-I** — downstream; consumes EPIC-H's green gate to proceed
  with xterm removal.
- **EPIC-J** — telemetry counters `degraded.dropped_input_count`,
  `degraded.recoveries`, `side_by_side.diff_count`.
- **EPIC-K** — CI grep rule for `tuiActive` / `needsAltScreen` /
  `altScreenVisible`.

## 13. Work breakdown

### Week 1 (5 working days)

- **Day 1** — `BlockList` row-range virtualization. Binary-search
  lookup. Absolute-positioned chrome. Unit tests. Visual test against
  `cellToScreen`.
- **Day 2** — `BlockList` continuation: scrollback promotion handling,
  alt-screen range case. `AltScreenStatusBar` widget. Integration with
  `TerminalPage`.
- **Day 3** — Alt-screen chrome collapse animations in `BlockCard` +
  `AltScreenStatusBar`. 160 ms fade + 2 s ghost + nested-depth text
  update. `preferences.altScreenTransition` wiring. Reduced-motion
  handling. Tests for E2E-H1 through E2E-H5 + E2E-H12.
- **Day 4** — Side-by-side harness. `data-renderer` attribute wiring.
  `side-by-side-diff.ts` function + recorder ring buffer. Input byte
  diff tap. Dev-only tree-shaking. Tests for E2E-H6, E2E-H7 against
  EPIC-G fixtures. `ModeChanged` single-source rework of
  `entities/tui/model.ts`. CI grep for legacy flags enabled.
- **Day 5** — Degraded-mode: `DegradedBanner` + `useDegradedMode`.
  Liveness signal subscription. Input drop + telemetry. ADR 0010
  localization row. Tests for E2E-H8 through E2E-H10. Final dogfood:
  run all 14 EPIC-G compat scenarios under canvas with side-by-side
  overlay enabled; confirm zero divergence; sign off §19 gate line
  "xterm vs canvas diff = 0".

### Post-week housekeeping

- Hand-off to EPIC-I: confirm §19 gate lines owned by EPIC-H are
  green:
  - `xterm vs canvas diff = 0 across matrix` — E2E-H6 + E2E-H7 +
    full EPIC-G matrix.
  - `Alt-screen enter/exit/nested OK` — E2E-H1 through E2E-H4.
  - `Resize during alt-screen OK` — E2E-H5.
  - `No black-screen failure` (§20) — E2E-H8.
- Archive dogfood log at `docs/dogfood/epic-h/week-1.md`.

---

## Appendix A — `useAltScreenMode()` hook API

```ts
export function useAltScreenMode(): {
  active: boolean;
  depth: number; // 0 when inactive; 1 = outermost; 2+ = nested
  crashed: { reason: string } | null;
  transitioning: boolean; // true during 160 ms fade
};
```

Single source of truth, subscribed from `GridMirror.getMode('AltScreen')`.
Components that need to adjust rendering (BlockCard, AltScreenStatusBar,
SideBySideHarness) read from here. No other call site reads alt-screen
state.

## Appendix B — Banner state machine

```
 healthy ── liveness pong ──▶ healthy
    │
    ├── event gap > 1 s ──▶ stalled (local hint, no banner)
    │
    └── engine death ──▶ degraded (banner shown)
                           │
                           └── restart clicked ──▶ healthy
```

`stalled → degraded` promotion: event gap > 5 s OR liveness ping fails
twice in a row OR sidecar-crash event received (ADR 0004).

`degraded → healthy`: ONLY via explicit restart. No auto-recovery;
auto-recovery risks flipping to a half-initialized engine and would
violate RFC §20 "recovery path observable + logged."

## Appendix C — Side-by-side opt-in path

1. User sets `preferences.renderer = 'side-by-side'` in settings
   (dev-only row).
2. Settings change emits an event; `TerminalPage` re-renders with
   `data-renderer="side-by-side"` root attribute.
3. `TerminalPage` mounts both `TerminalCanvas` and `TerminalShell`
   (xterm) in a split layout.
4. `SideBySideHarness` component intercepts the event stream from
   `GridMirror` and forks it to both renderers.
5. `useEffect` schedules `diffFrames()` every 10 frames (configurable).
6. Diffs are appended to the ring recorder.
7. Dev-tools button "Export diff" downloads the ring as JSON.

## Appendix D — Banner copy table (additions to ADR 0010 localization)

| Key | Copy (en) | Primary action |
|-----|-----------|----------------|
| `degraded.engine_crashed` | `Engine crashed; last frame preserved. Restart session to continue.` | `Restart session` |
| `degraded.bridge_lost` | `Lost connection to host bridge. Last frame preserved.` | `Reconnect` |
| `degraded.replay_stuck` | `Session replay stuck. Reset to latest snapshot.` | `Reset` |

Only the first row is landed in this epic; rows 2-3 are placeholders
for follow-up sidecar-lifecycle work (ADR 0004 extensions).

---

**End of EPIC-H plan.**
