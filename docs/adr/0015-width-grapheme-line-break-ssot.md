# ADR 0015 — Width, Grapheme, and Line-Break Single Source of Truth

- **Status**: Proposed (skeleton — fleshed out during RFC 0001 Phase 6.1)
- **Date**: 2026-04-19
- **Related**: RFC 0001 §7.2 (width SSOT callout), RFC 0001 §16 (failure modes 5-7)

## Context

Cell width (how many columns a grapheme cluster occupies) is the single most load-bearing number in a terminal emulator. It determines:

- Where the cursor lands after printing a character.
- How subsequent characters are laid out on the same row.
- How selection / hit-testing map screen pixels to cells.
- How wrapping decides to start a new row.

If engine (Rust) and UI (TypeScript) disagree on the width of even one grapheme, vim displays corrupted. Selection copies the wrong substring. tmux pane boundaries tear. **This cannot be a library-by-library decision.** There is one table, two consumers.

This ADR establishes that table.

## Decision

1. **Grapheme segmentation**: `unicode-segmentation` crate (Rust) + a pinned same-version TS port (via wasm-bindgen or hand-port with parity test). Unicode version tracked explicitly in `quanta-vt-width/Cargo.toml` — bumps require a parity-test run.

2. **Base width rule**: `unicode-width` crate for code point → width. Rust side canonical; TS side calls a WASM build of the same crate or uses a generated lookup table derived from it.

3. **Curated override table**: a small, explicitly maintained list of overrides for code points where upstream `unicode-width` disagrees with terminal reality or user expectation. Initial entries: emoji presentation variants, VS16/VS15 handling, a few CJK ambiguous-width corners. Override table is committed, versioned, diff-reviewed.

4. **CJK ambiguous-width policy**: a per-user setting, default resolved by heuristic:
   - macOS / Windows default: **narrow** (matches Apple Terminal, Windows Terminal).
   - Linux with `$LANG` containing `ko`, `ja`, `zh`: **wide**.
   - Linux otherwise: **narrow**.
   - Users override in Settings.
   The engine receives the policy on session boot and holds it for the session lifetime. Changing it re-flows the grid.

5. **ZWJ sequences**: width = width of the base glyph (typically 1 or 2), NOT sum of joined parts. `👨‍👩‍👧‍👦` = 2 cells.

6. **Variation selectors**: `VS16` (U+FE0F) forces width=2 for text-presentation code points it follows. `VS15` (U+FE0E) forces width=1 for emoji-presentation code points.

7. **Combining marks**: width = 0; attach to the preceding grapheme cluster.

8. **DEC line drawing characters** (DEC special graphics charset): narrow (width=1), always.

9. **Wrapping (DECAWM)**: wrapped continuation rows are tagged with a `continuation: true` flag so selection/copy can re-join lines that were only visually split. Explicit `\n`-terminated rows are `continuation: false`.

10. **Reflow on resize**: continuation-flagged sequences re-flow to new column width. Non-continuation rows keep their line breaks.

## Parity enforcement

- A golden table in `quanta-vt-width/tests/width_corpus.txt`: `code_point <TAB> expected_width`. ≥ 500 entries covering ASCII, Latin-1 extensions, combining marks, CJK common, CJK compatibility, emoji common, emoji ZWJ sequences, VS16 pairs, line-drawing.
- Rust test: iterate the corpus, assert match.
- TS test (vitest): iterate the same corpus via the TS port (WASM-bound or generated), assert match.
- Both tests in CI. A divergence fails both.

## Consequences

- One extra crate (`quanta-vt-width`) and one extra parity test, but zero ambiguity on width decisions.
- The curated override table is a living document; additions require PR + test.
- CJK ambiguous-width is settable but defaults sensibly; we don't pretend there's one right answer.
- Width is now portable across engine and UI. Hit-test, selection, cursor arithmetic all consistent.

## Open (to resolve during Phase 6.1 implementation)

- Exact WASM vs port decision for the TS side (perf vs packaging tradeoff).
- Whether to expose width overrides as a user-editable dotfile (like `WezTerm` allows) — probably yes, deferred to v1.1.
- How Settings surfaces the CJK ambiguous-width choice: auto-detect with opt-out vs explicit choice on first run.
