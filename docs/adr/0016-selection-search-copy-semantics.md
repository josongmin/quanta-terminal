# ADR 0016 — Selection, Search, and Copy Semantics

- **Status**: Accepted (v1 decisions locked)
- **Date**: 2026-04-19
- **Accepted**: 2026-04-19 (EPIC-D implementation agent — Phase 6.5)
- **Related**: RFC 0001 §7.5.2 (hit-testing + selection callout), §11 (selection/copy/search authority), §13.8 (selection/copy acceptance), ADR 0015 (width SSOT — selection depends on width), EPIC-D `docs/plans/0001-custom-vt-engine-xterm-removal/epic-D-canvas-renderer-selection.md` (consumer)

## Context

Selection, search, and copy are three surfaces of the same underlying concern: **mapping visual ranges on screen to underlying cells, and mapping underlying cells back to bytes the user can paste / search against.**

In the current (xterm + block) world, these three live in two places with different models:

- Block surface: plain text per block; selection is DOM-ranges over rendered HTML; copy is via browser `document.execCommand('copy')` or similar.
- xterm surface: xterm's own selection manager; copy via xterm's API.

Cross-surface selection is effectively impossible. Cross-surface search is not implemented.

With the unified engine (RFC 0001), all three become properties of **the cell grid**. This ADR locks that down before the renderer ships, so the data model supports it from day one.

## Decision

### 1. Cell-coordinate selection model

Selection is a range on the cell grid, not a DOM range.

```ts
type SelectionMode = 'char' | 'word' | 'line' | 'block'; // 'block' = rectangular
type SelectionAnchor = {
  row: number;      // absolute row index in (scrollback + main) space
  col: number;
};
type Selection = {
  start: SelectionAnchor;
  end: SelectionAnchor;
  mode: SelectionMode;
};
```

Selection is stored on the UI side only; not sent over the wire.

### 2. Anchor normalization

`start` and `end` are stored as given. A derived `normalized()` returns them sorted top-to-bottom, left-to-right. Most operations (copy, highlight) use the normalized form.

### 3. Hit-testing contracts

- `screenToCell(x: number, y: number): SelectionAnchor | null` — maps a mouse/pointer position to a cell. Returns `null` if outside the grid (e.g., block chrome).
- `cellToScreen(row: number, col: number): Rect` — inverse. Used for selection highlighting.
- Both honor the width rule (ADR 0015): a wide cell is 2 columns wide; its right half (`CellWidth::Zero` marker) maps to the SAME anchor as the left half.

### 4. Selection modes

| Mode | Trigger | Behavior |
|---|---|---|
| `char` | drag | anchor to cell under pointer |
| `word` | double-click | extend to word boundaries (Unicode word break) |
| `line` | triple-click | extend to full row (or wrap-joined sequence; see §5) |
| `block` | `Alt`+drag (macOS `Opt`+drag) | rectangular region |

### 5. Copy normalization

Different from visual selection. Visual highlight shows what the user sees; copy produces text that is actually useful.

- `continuation: true` rows (wrap) are **re-joined** with no separator. A visual 3-line wrapped command becomes one line on copy.
- `continuation: false` rows keep their separator (`\n`).
- `block` mode: each visual row becomes its own line; columns are padded with spaces where selection extends past a row's last cell (standard rectangular-copy convention).
- Trailing whitespace on each line is stripped unless user holds `Opt`/`Alt` at copy time (power-user knob).
- SGR attributes stripped. HTML-copy (with colors) is a follow-up, deferred.

### 6. Scope: what can and cannot be selected simultaneously

- Scrollback rows can be selected together with current main-buffer rows.
- Alt-screen cells can be selected (for copying `vim` buffer content etc.).
- **Scrollback and alt-screen cannot be in the same selection.** Switching scope clears selection. Rationale: cross-scope selection has no meaningful copy semantics (the two buffers share column indices but mean different things).

### 7. Search

- Query: a plain string (case-insensitive by default, `/` regex toggle).
- Executes against the cell grid + scrollback, with `continuation`-aware row joining so wrapped matches work.
- Results returned as a list of `SelectionAnchor` ranges.
- `Cmd+G` / `Ctrl+G` cycles through matches with viewport-scrolling.
- Alt-screen: search operates on the alt buffer when alt-screen is active; on main+scrollback otherwise.

### 8. Hyperlinks (OSC 8)

- Hyperlink spans stored alongside cells (by `HyperlinkId`).
- Hit-test at `screenToCell` returns the hyperlink if any.
- Modifier-click (`Cmd`/`Ctrl`) opens: `file:` or absolute path → `openInEditor`; `http`/`https` → `openUrl` (new bridge method); other schemes → system default via `openUrl`.
- Plain click (no modifier) selects like a normal word.

### 9. Bracketed paste interaction

- When pasting, bracketed paste (DECSET 2004) is honored automatically by the input path (RFC 0001 §7.3.4). Copy→paste of selected text from Quanta's own grid goes through the same path.

### 10. OSC 52 paste from terminal programs

Handled per RFC 0001 §7.3.5 (permission-gated). A program's OSC 52 write does NOT overwrite the user's selection — it targets the system clipboard directly, separately from the user's local selection state.

## Consequences

- The renderer's data model includes hit-test + selection from the first sprint. No retrofit.
- Copy produces useful text (wrap-joined) out of the box; no "why is my pasted command split across lines" bug.
- Search works uniformly across scrollback + main; parity with modern terminals.
- Hyperlinks are first-class, not a hack.
- Cross-scope scrollback+alt-screen selection is disallowed. Users may dislike this; the alternative is worse (nonsensical copy).

## Resolved (v1 decisions — locked by EPIC-D)

Every Open Question from the skeleton is resolved below. Implementation references are the corresponding test files in `packages/ui/src/shared/ui/cell-renderer/__tests__/` and `packages/ui/src/widgets/terminal-canvas/__tests__/`.

1. **Word-boundary algorithm** — Unicode word break via `Intl.Segmenter(undefined, { granularity: 'word' })`. Chosen over locale-agnostic regex because it handles CJK-segmentation, emoji clusters, ZWJ sequences, and punctuation boundaries correctly out of the box with zero bundle cost (runtime built-in). Covered by `Selection.test.ts > word mode` scenarios.

2. **Block-mode (rectangular) modifier** — **Opt on macOS, Alt on other platforms**. Both map to `altKey` in DOM events. Implementation uses `platformBlockModeModifier(platform)` which currently returns `'altKey'` uniformly (platform-specific variants are keyed via the `platform` prop for future divergence). Rationale: matches macOS `Terminal.app` + `iTerm2` convention; aligns with Warp's rectangular-select chord.

3. **Copy-on-select vs Cmd+C default** — **Cmd+C (Ctrl+C on non-macOS) is the default**. Copy-on-select is **off** by default. A session-level setting (`selection.copyOnSelect`) is exposed; Linux users are the primary audience since X11 primary-selection semantics blur "selection" with "clipboard". Off-by-default avoids the silent-clipboard-steal surprise on macOS/Windows where users don't expect copy-on-select.

4. **Middle-click paste (X11 primary selection)** — **Honored on Linux X11 only**. Gated by `platform === 'linux'` and the presence of a running X server; on Wayland and non-Linux, middle-click is ignored. Rationale: X11 PRIMARY is a cultural expectation on Linux; reproducing it on Wayland without a corresponding primary buffer would emit inconsistent data.

5. **Search engine** — **Native JS `RegExp`**. Rust's `regex` crate is **not** bundled in v1. Reasons:
   - Deterministic: `RegExp` is present in every browser + Node runtime the UI targets.
   - Zero bundle cost: no WASM blob shipped.
   - Scope is bounded: typical grids are 120×40 with scrollback in the single-digit-thousands-of-rows range. `RegExp.exec` amortizes to a few ms.
   - If scrollback grows past 100k rows, a Rust-side engine can drop in behind `Search.buildLogicalView` without surface-level API changes. Treated as a follow-up.

6. **Shift-click vs Cmd-click extension** — **Shift-click extends the active selection; Cmd-click (macOS) or Ctrl-click (elsewhere) opens hyperlinks**. Multi-selection is out of v1 (no multi-range support). Rationale: single-range selection + hyperlink-click is the 99% case; multi-range adds anchor-book-keeping complexity without a clear workflow win.

7. **"Find in block" vs "Find in grid"** — **Two distinct surfaces**. ADR 0013 history search returns `Block[]` (command-level navigation); EPIC-D's `Search` returns `SelectionAnchor[]` on the grid (cell-level navigation). Keyboard shortcuts: `Cmd/Ctrl+Shift+F` history search, `Cmd/Ctrl+F` grid search. Documented in `TerminalCanvas` widget docs.

8. **Copy-on-Alt-held: trailing-whitespace preservation** — **Held Alt/Opt at copy time passes `preserveTrailingWhitespace: true`**. This is a power-user knob; default off keeps pasted-command lines clean.
