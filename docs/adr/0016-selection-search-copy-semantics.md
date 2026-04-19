# ADR 0016 — Selection, Search, and Copy Semantics

- **Status**: Proposed (skeleton — fleshed out during RFC 0001 Phase 6.5)
- **Date**: 2026-04-19
- **Related**: RFC 0001 §7.5.2 (hit-testing + selection callout), ADR 0015 (width SSOT — selection depends on width)

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

## Open (to resolve during Phase 6.5 implementation)

- Shift-click extension vs Cmd-click multi-select (pick one convention and ship).
- "Find in block" (ADR 0013 history search) vs "Find in grid" — are they the same surface or two? Likely two: history search returns blocks, grid search returns cell anchors. Document clearly in UI.
- Regex engine for `/` search: `regex` crate (Rust, fast) vs native JS `RegExp`. Probably JS for simplicity; Rust only if grid is huge (>100k rows).
- Copy-on-select vs copy-on-cmd-c (platform convention): default to cmd-c; add setting for copy-on-select.
