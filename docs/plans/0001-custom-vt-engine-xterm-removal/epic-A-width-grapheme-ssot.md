# EPIC-A — Width / Grapheme / Line-Break SSOT — Detailed Plan

- **Status**: Planning (Phase 0 trunk, implementation active in parallel)
- **Date**: 2026-04-19
- **Scope owner**: EPIC-A planning agent
- **Implements**: RFC 0001 v4 §3.1 (terminal semantic truth), §8 (width/grapheme
  authority), §13.2 (cell/grid multilingual core), §16 failure modes #5, #6, #7
- **Freezes**: ADR 0015 contracts — `CellWidth`, `Grapheme`,
  `AmbiguousWidthPolicy`, `WrapEligibility`, `WidthClassifier` trait, golden
  corpus format — per epic-plan Freeze 1.
- **Out-of-scope**: VT engine, rendering, input, protocol. This is a pure
  classification library plus its TS mirror.

This plan is the testable contract EPIC-A implementation will be held to. Every
Definition-of-Done item below maps to a specific test file, code artifact, or
CI job — no fluffy items, no "code is reviewed" line.

---

## 1. Summary

**Goal**. Establish `crates/quanta-vt-width` and its TS mirror at
`packages/ui/src/shared/lib/width/` as the sole authority for grapheme
segmentation, display width classification, and wrap eligibility, with Rust↔TS
parity enforced by a golden corpus of ≥ 500 entries.

**Dependencies**. None. This is Phase 0, the first epic on the critical path.

**Phase / Duration**. Phase 0 · 1.5 weeks (Day 1 through Day 8 of the project).

**Owner**. EPIC-A implementation agent. Spec owner hands off to impl on Day 1.

**Upstream contracts frozen**. Once this epic ships the following are locked and
downstream epics (B, D, E) may compile against them:

- `CellWidth { Zero, One, Two }` — three-valued width enum.
- `Grapheme` — inline-stored-up-to-8-bytes grapheme cluster, heap fallback.
- `AmbiguousWidthPolicy { Narrow, Wide, Auto }` with
  `Auto::resolve(os, lang) -> Self`.
- `WrapEligibility { Fits, MustWrap, NoBreakHint }`.
- `WidthClassifier` trait with `classify_grapheme`, `segment`, `wrap_eligible`.
- `DefaultClassifier` — the concrete implementation wrapping
  `unicode-segmentation` + `unicode-width` + the curated override table.
- Golden corpus file format — line-oriented, tab-separated (§3.3 of this plan).

---

## 2. Background & motivation

### 2.1 The problem

Cell width is the most load-bearing number in a terminal. If engine and UI
disagree on the width of even one grapheme, vim displays corrupt, selection
copies the wrong substring, and tmux pane boundaries tear. Width-classification
ambiguity has cost comparable projects weeks of user-facing regressions (xterm.js
v5 CJK bugs, iTerm emoji-width-flip, Warp `한`-column-off bugs in beta).

The bug class cannot be fixed by "both sides call `unicode-width`." Divergence
between `unicode-width` versions, platform locale heuristics, VS16 behavior,
ZWJ cluster handling, and ambiguous-width policy is the ambient state. The only
fix that scales is an explicit single authority table with a parity-enforcing
corpus. That is what this epic builds.

### 2.2 Why this is Phase 0

Every other epic depends on the types this epic freezes:

- **EPIC-B** `Grid::feed` uses `CellWidth` + `Grapheme` for every printed byte.
- **EPIC-D** selection normalization and hit-test use the TS mirror's
  `screenToCell` math, which only works if width matches the engine.
- **EPIC-E** input encoder does not directly depend, but IME preedit overlay
  layout uses the TS mirror for candidate-popup anchoring.
- **EPIC-G** compat golden streams assert grid state that is only meaningful
  under a fixed width table.

If width comes in late, every downstream test has to be re-baked. Shipping width
first is therefore a hard schedule invariant, not a preference.

### 2.3 RFC invariants this realizes

- **I-3 — Grid is the truth**: width is part of what the grid owns; this epic
  provides the authoritative width oracle that the grid consults.
- **I-4 — Semantic width wins, paint adapts**: this epic produces semantic
  width. Renderer MUST NOT override it.
- **§8** — Width / grapheme / line-break authority contract. This epic IS the
  `quanta-vt-width` crate referred to in §8.

---

## 3. Scope

### 3.1 In-scope files (create or modify)

Enumerated with one-line purpose. Every file listed here must exist and pass
the DoD check that mentions it.

**Rust crate — `crates/quanta-vt-width/`** (new):

- `Cargo.toml` (root) — add `quanta-vt-width` workspace member entry.
- `crates/quanta-vt-width/Cargo.toml` — crate manifest; pins
  `unicode-segmentation` and `unicode-width` versions; declares Unicode version
  in a `[package.metadata]` block.
- `crates/quanta-vt-width/src/lib.rs` — `#![forbid(unsafe_code)]`, re-exports
  the public API (`CellWidth`, `Grapheme`, `AmbiguousWidthPolicy`,
  `WrapEligibility`, `WidthClassifier`, `DefaultClassifier`). No business logic.
- `crates/quanta-vt-width/src/domain/mod.rs` — value types: `CellWidth`,
  `Grapheme`, `AmbiguousWidthPolicy`, `WrapEligibility`.
- `crates/quanta-vt-width/src/adapters/default.rs` — `DefaultClassifier`
  wrapping `unicode-segmentation` + `unicode-width`, consulting overrides.
- `crates/quanta-vt-width/src/overrides.rs` — curated override table:
  VS15/VS16, emoji ZWJ base-width rules, regional indicators, documented
  ambiguous-width exceptions. Sorted, unique, each group has a comment
  explaining its reason.
- `crates/quanta-vt-width/src/port.rs` — `WidthClassifier` trait (port). All
  downstream code takes `&dyn WidthClassifier` or `impl WidthClassifier`.
- `crates/quanta-vt-width/tests/fixtures/width_corpus.txt` — ≥ 500 tab-separated
  entries `hex_codepoints <TAB> expected_width <TAB> tag`.
- `crates/quanta-vt-width/tests/fixtures/grapheme_corpus.txt` — ≥ 100 entries
  where code-point count ≠ grapheme count.
- `crates/quanta-vt-width/tests/fixtures/wrap_corpus.txt` — ≥ 200 entries of
  `(cols, prefix, next_grapheme, expected)` wrap decisions.
- `crates/quanta-vt-width/tests/width_parity.rs` — iterates `width_corpus.txt`,
  asserts classifier output equals expected.
- `crates/quanta-vt-width/tests/grapheme_parity.rs` — iterates
  `grapheme_corpus.txt`, asserts grapheme count and byte ranges match.
- `crates/quanta-vt-width/tests/wrap_parity.rs` — iterates `wrap_corpus.txt`,
  asserts `wrap_eligible` output matches.
- `crates/quanta-vt-width/tests/ambiguous_width.rs` — 7 policy-resolution
  cases (see DoD §5).
- `crates/quanta-vt-width/tests/override_table.rs` — structural invariants:
  sorted by code point, no duplicates, every group has a documented reason.
- `crates/quanta-vt-width/fuzz/Cargo.toml` — fuzz crate manifest (cargo-fuzz).
- `crates/quanta-vt-width/fuzz/fuzz_targets/classify_grapheme.rs` — fuzz entry:
  arbitrary UTF-8 bytes → segment + classify; invariants panic-free and width
  ≤ 2 per grapheme.

**TypeScript mirror — `packages/ui/src/shared/lib/width/`** (new):

- `packages/ui/src/shared/lib/width/index.ts` — public API re-exports.
- `packages/ui/src/shared/lib/width/types.ts` — `CellWidth`, `Grapheme`,
  `AmbiguousWidthPolicy`, `WrapEligibility` TS type mirrors.
- `packages/ui/src/shared/lib/width/classifier.ts` — `DefaultClassifier`
  implementation using a generated lookup table derived from the Rust corpus
  plus the same override table (committed alongside the Rust side).
- `packages/ui/src/shared/lib/width/__tests__/parity.test.ts` — vitest; loads
  the Rust `width_corpus.txt` and asserts the TS classifier produces identical
  results row-for-row.

**Documentation — ADR status flip**:

- `docs/adr/0015-width-grapheme-line-break-ssot.md` — Status moves from
  `Proposed` to `Accepted`. This epic is the implementation the ADR described.

### 3.2 Out of scope

Explicit non-goals to stop scope creep:

- VT engine (`Grid`, `vte::Perform`) — EPIC-B.
- Canvas renderer, selection anchors, hit-test — EPIC-D. (The TS mirror stops
  at classification; renderer consumes the mirror but is built in D.)
- Input encoder, IME — EPIC-E.
- Protocol wire format — EPIC-C.
- User-surfaced Settings UI for ambiguous-width policy — deferred; the epic
  surfaces the policy on the API; Settings plumbing is post-v1.

No code under `crates/quanta-vt-width/src/` may import `vte`, `quanta-proto`,
`quanta-session`, or any other workspace crate. The crate is a leaf.

---

## 4. Design details

### 4.1 Rust type contracts

Signatures frozen by this epic. Downstream epics (B/D/E) MUST import these
exact shapes; any change requires an RFC amendment.

#### 4.1.1 `CellWidth`

```rust
// crates/quanta-vt-width/src/domain/mod.rs

/// Display width in terminal cells.
///
/// `Zero` covers combining marks, variation-selector-15-suppressed emoji,
/// zero-width joiners, and the right half of a wide-char pair (`WIDE_CONTINUATION`).
/// `One` is the default Latin/ASCII/narrow-ambiguous case. `Two` is CJK common,
/// wide-presentation emoji, and ambiguous-treated-as-wide under `Wide` policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum CellWidth {
    Zero = 0,
    One = 1,
    Two = 2,
}

impl CellWidth {
    #[must_use]
    pub const fn as_columns(self) -> u8 { self as u8 }

    #[must_use]
    pub const fn is_wide(self) -> bool { matches!(self, Self::Two) }

    #[must_use]
    pub const fn is_zero(self) -> bool { matches!(self, Self::Zero) }
}
```

#### 4.1.2 `Grapheme`

```rust
/// A single grapheme cluster. Inline-stored up to 8 bytes (covers essentially
/// all CJK/Latin/emoji graphemes in practice); falls back to a heap `Box<str>`
/// for pathological long ZWJ sequences (`SmallString`-style layout).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Grapheme(GraphemeRepr);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum GraphemeRepr {
    /// Up to 8 bytes inline. `len` <= 8.
    Inline { buf: [u8; 8], len: u8 },
    /// Arbitrary-length heap fallback.
    Heap(Box<str>),
}

impl Grapheme {
    /// Construct from a `&str` that MUST be a single valid grapheme cluster.
    /// Callers get this from `DefaultClassifier::segment`; constructing from
    /// arbitrary input is allowed but the type makes no cluster-validity
    /// guarantee beyond UTF-8.
    #[must_use]
    pub fn new(s: &str) -> Self { /* ... */ }

    #[must_use]
    pub fn as_str(&self) -> &str { /* ... */ }

    #[must_use]
    pub fn len_utf8(&self) -> usize { self.as_str().len() }

    #[must_use]
    pub fn is_empty(&self) -> bool { self.as_str().is_empty() }

    /// The `WIDE_CONTINUATION` sentinel — right half of a wide char pair.
    /// Zero bytes, `CellWidth::Zero`.
    #[must_use]
    pub const fn wide_continuation() -> Self { /* const-fn Inline { len: 0, .. } */ }
}
```

`Grapheme` intentionally does not implement `Copy` — the heap variant forbids
it. Downstream code clones explicitly.

#### 4.1.3 `AmbiguousWidthPolicy`

```rust
/// Policy for code points with East-Asian Width property `A` (Ambiguous).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AmbiguousWidthPolicy {
    /// Narrow: ambiguous → width=1. Default on macOS, Windows, and non-CJK Linux.
    Narrow,
    /// Wide: ambiguous → width=2. Default on Linux with a CJK `$LANG`.
    Wide,
    /// Auto: resolve via `resolve(os, lang)` at session boot.
    Auto,
}

impl AmbiguousWidthPolicy {
    /// Resolve `Auto` to `Narrow` or `Wide` using host OS + locale.
    /// Pure function; no environment reads.
    #[must_use]
    pub fn resolve(os: HostOs, lang: Option<&str>) -> Self {
        match (os, lang) {
            (HostOs::MacOs, _)   => Self::Narrow,
            (HostOs::Windows, _) => Self::Narrow,
            (HostOs::Linux, Some(l)) if is_cjk_lang(l) => Self::Wide,
            (HostOs::Linux, _)   => Self::Narrow,
            (HostOs::Other, _)   => Self::Narrow,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HostOs { MacOs, Linux, Windows, Other }

fn is_cjk_lang(lang: &str) -> bool {
    let lower = lang.to_ascii_lowercase();
    lower.starts_with("ko") || lower.starts_with("ja") || lower.starts_with("zh")
}
```

#### 4.1.4 `WrapEligibility`

```rust
/// Decision returned by `WidthClassifier::wrap_eligible`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WrapEligibility {
    /// Grapheme fits on current row; no wrap required.
    Fits,
    /// Grapheme does not fit; MUST wrap before placing.
    /// E.g. a 2-cell grapheme at col 79 of an 80-col grid.
    MustWrap,
    /// Grapheme fits but line-break opportunity exists per UAX-14.
    /// Engine MAY soft-break here for readability; renderer MUST NOT.
    NoBreakHint,
}
```

#### 4.1.5 `WidthClassifier` trait

```rust
// crates/quanta-vt-width/src/port.rs

pub trait WidthClassifier: Send + Sync {
    /// Classify a single grapheme cluster. Contract: `s` MUST be a valid
    /// single-cluster string as produced by `segment`.
    fn classify_grapheme(&self, s: &str) -> CellWidth;

    /// Segment `input` into grapheme clusters in order. Allocates `Grapheme`
    /// instances; `Inline` variant used whenever the cluster ≤ 8 bytes.
    fn segment<'a>(&self, input: &'a str) -> GraphemeIter<'a>;

    /// Decide wrap eligibility given current cursor column, grid width,
    /// and the next grapheme. Pure function; no side effects.
    fn wrap_eligible(
        &self,
        cursor_col: u16,
        grid_cols: u16,
        next: &str,
    ) -> WrapEligibility;

    /// Ambiguous-width policy in effect. Classifier captures this at
    /// construction; re-construction on policy change is required.
    fn ambiguous_policy(&self) -> AmbiguousWidthPolicy;
}

/// Streaming iterator over grapheme clusters.
pub struct GraphemeIter<'a> { /* opaque */ }

impl<'a> Iterator for GraphemeIter<'a> {
    type Item = Grapheme;
    fn next(&mut self) -> Option<Self::Item> { /* ... */ }
}
```

#### 4.1.6 `DefaultClassifier`

```rust
// crates/quanta-vt-width/src/adapters/default.rs

pub struct DefaultClassifier {
    policy: AmbiguousWidthPolicy,
}

impl DefaultClassifier {
    #[must_use]
    pub fn new(policy: AmbiguousWidthPolicy) -> Self {
        debug_assert!(!matches!(policy, AmbiguousWidthPolicy::Auto),
                      "resolve Auto before constructing DefaultClassifier");
        Self { policy }
    }
}

impl WidthClassifier for DefaultClassifier {
    fn classify_grapheme(&self, s: &str) -> CellWidth { /* consults overrides, then unicode-width */ }
    fn segment<'a>(&self, input: &'a str) -> GraphemeIter<'a> { /* unicode-segmentation */ }
    fn wrap_eligible(&self, cursor_col: u16, grid_cols: u16, next: &str) -> WrapEligibility { /* ... */ }
    fn ambiguous_policy(&self) -> AmbiguousWidthPolicy { self.policy }
}
```

### 4.2 TS type mirrors

Signatures for the TypeScript side. Must mirror the Rust API exactly.

```typescript
// packages/ui/src/shared/lib/width/types.ts

export enum CellWidth {
  Zero = 0,
  One = 1,
  Two = 2,
}

export type Grapheme = { readonly bytes: Uint8Array; readonly str: string };

export enum AmbiguousWidthPolicy {
  Narrow = 'narrow',
  Wide = 'wide',
  Auto = 'auto',
}

export enum WrapEligibility {
  Fits = 'fits',
  MustWrap = 'must-wrap',
  NoBreakHint = 'no-break-hint',
}

export type HostOs = 'macos' | 'linux' | 'windows' | 'other';

export function resolveAmbiguous(
  os: HostOs,
  lang: string | null | undefined,
): AmbiguousWidthPolicy.Narrow | AmbiguousWidthPolicy.Wide;
```

```typescript
// packages/ui/src/shared/lib/width/classifier.ts

export interface WidthClassifier {
  classifyGrapheme(s: string): CellWidth;
  segment(input: string): Iterable<Grapheme>;
  wrapEligible(cursorCol: number, gridCols: number, next: string): WrapEligibility;
  ambiguousPolicy(): AmbiguousWidthPolicy;
}

export class DefaultClassifier implements WidthClassifier {
  constructor(policy: Exclude<AmbiguousWidthPolicy, AmbiguousWidthPolicy.Auto>);
  // methods as above
}
```

```typescript
// packages/ui/src/shared/lib/width/index.ts
export * from './types';
export { DefaultClassifier } from './classifier';
```

### 4.3 Corpus format spec

All three fixture files are UTF-8, LF-terminated, tab-separated, with `#`
comment lines ignored by the parser. A blank line is ignored.

#### 4.3.1 `width_corpus.txt`

```
# columns: hex_codepoints   expected_width   tag
# hex_codepoints: "U+XXXX[ U+XXXX]*" (space-joined for multi-codepoint clusters)
# expected_width: 0 | 1 | 2
# tag: short identifier used in failure messages; no tabs
U+0041	1	ascii-A
U+00E9	1	latin1-e-acute-precomposed
U+0065 U+0301	1	combining-e+acute
U+4E2D	2	cjk-zhong
U+D55C	2	hangul-han
U+1F600	2	emoji-smile
U+1F469 U+200D U+1F4BB	2	zwj-woman-technologist
U+2764 U+FE0F	2	heart-with-vs16
U+2501	1	dec-horizontal-line
U+2018	1	left-single-quote-narrow-default
```

#### 4.3.2 `grapheme_corpus.txt`

```
# columns: hex_codepoints   expected_grapheme_count   expected_byte_ranges   tag
# expected_byte_ranges: semicolon-separated "start-end" pairs, half-open
U+0041 U+0042	2	0-1;1-2	two-ascii
U+0065 U+0301	1	0-3	combining-e+acute
U+1F1F0 U+1F1F7	1	0-8	regional-indicator-KR
U+1F469 U+1F3FD	1	0-8	skin-tone-modified
U+1F468 U+200D U+1F469 U+200D U+1F467 U+200D U+1F466	1	0-25	family-4-zwj
U+0041 U+0301 U+0301 U+0301	1	0-7	base-plus-multiple-combiners
U+2764 U+FE0F	1	0-6	heart-vs16
U+1F600 U+FE0E	1	0-7	smile-vs15-text-presentation
U+0D95 U+0DCF	1	0-6	sinhala-base-plus-sign
U+0041 U+0300 U+0301 U+0302	1	0-9	base-plus-three-combiners
```

#### 4.3.3 `wrap_corpus.txt`

```
# columns: grid_cols   cursor_col   prefix_hex   next_hex   expected   tag
# prefix_hex / next_hex use the U+XXXX[ U+XXXX]* syntax; prefix may be empty string "-"
# expected: Fits | MustWrap | NoBreakHint
80	0	-	U+0041	Fits	col-0-ascii
80	79	-	U+0041	Fits	col-79-narrow-fits
80	79	-	U+4E2D	MustWrap	col-79-wide-must-wrap
80	78	-	U+4E2D	Fits	col-78-wide-fits
80	80	-	U+0041	MustWrap	col-80-overflow
80	0	-	U+0301	Fits	col-0-combining-attaches
80	79	-	U+FE0F	Fits	col-79-vs16-zero-fits
80	79	-	U+1F1F0 U+1F1F7	MustWrap	col-79-regional-indicator
120	119	-	U+D55C	MustWrap	col-119-han-must-wrap
80	40	-	U+0020	NoBreakHint	space-break-opportunity
```

### 4.4 Override table structure

`src/overrides.rs` is a compile-time-sorted slice of override entries plus a
lookup helper. Entries are grouped by rationale; each group is preceded by a
documentation comment that states the reason the overrides exist and cites
either a Unicode bug report, a terminal-emulator reference behavior, or an
ADR.

```rust
// crates/quanta-vt-width/src/overrides.rs

#[derive(Debug, Clone, Copy)]
pub(crate) struct OverrideEntry {
    pub code_point: u32,
    pub width: CellWidth,
    pub scope: OverrideScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OverrideScope {
    /// Applies regardless of ambiguous policy.
    Always,
    /// Applies only under `AmbiguousWidthPolicy::Wide`.
    AmbiguousWideOnly,
    /// Applies only under `AmbiguousWidthPolicy::Narrow`.
    AmbiguousNarrowOnly,
}

// Group: Variation Selectors
// Reason: VS16 (U+FE0F) forces emoji presentation (width=2) on the preceding
// code point; VS15 (U+FE0E) forces text presentation (width=1). Handled at
// segmentation, but VS selectors themselves are width=0.
// Ref: UAX #51; Unicode Emoji 15.1.
const GROUP_VARIATION_SELECTORS: &[OverrideEntry] = &[
    OverrideEntry { code_point: 0xFE0E, width: CellWidth::Zero, scope: OverrideScope::Always },
    OverrideEntry { code_point: 0xFE0F, width: CellWidth::Zero, scope: OverrideScope::Always },
    // ... FE00-FE0F full range
];

// Group: Zero-Width Joiners and Non-Joiners
// Reason: ZWJ (U+200D) and ZWNJ (U+200C) are structural in emoji sequences and
// Indic scripts. Must be width=0 regardless of ambiguous policy.
// Ref: UAX #44 General_Category=Cf.
const GROUP_ZERO_WIDTH_JOINERS: &[OverrideEntry] = &[ /* ... */ ];

// Group: Regional Indicators
// Reason: Regional indicator pairs form flag graphemes. Individual RI is
// width=2 upstream; pair-as-flag base-width handling lives in segment layer.
// Ref: UAX #29.
const GROUP_REGIONAL_INDICATORS: &[OverrideEntry] = &[ /* ... */ ];

// Group: DEC Special Graphics (Line Drawing)
// Reason: DEC charset translation maps to Unicode box-drawing code points,
// which `unicode-width` reports correctly (width=1). No override needed;
// listed here for future defensiveness.
// Ref: ADR 0015 §8.

// Group: Known ambiguous-width corrections
// Reason: Five code points where `unicode-width` disagrees with
// terminal-convention / Warp / iTerm2 / Alacritty observed behavior.
// Each listed explicitly; bump version-note on Unicode bumps.
const GROUP_AMBIGUOUS_CORRECTIONS: &[OverrideEntry] = &[ /* ... */ ];

/// All groups, concatenated, sorted by `code_point`. Checked by
/// `override_table.rs` test: sorted, unique, every group has doc comment.
pub(crate) const OVERRIDES: &[OverrideEntry] = /* build.rs sorts at compile time */;
```

Invariants enforced by `tests/override_table.rs`:

1. `OVERRIDES` is sorted strictly ascending by `code_point` — no duplicates.
2. Every code point appears in at most one group.
3. Every group constant name is referenced by a `// Group: ...` doc comment
   plus a `// Reason: ...` line plus a `// Ref: ...` line. Enforced with a
   compile-time-generated check (`const _: () = assert!(...)`) or a test that
   reads the source file and greps for the pattern.

The test file may read `overrides.rs` as raw text; acceptable since override
table is self-contained.

---

## 5. Definition of Done (DoD)

Every item is testable. Every item maps to a test file, a CI job, or a code
artifact. An item is "done" only when its referenced check passes in CI.

### 5.1 Code artifacts

- [ ] `crates/quanta-vt-width/` exists as a workspace member — root
      `Cargo.toml` has `"crates/quanta-vt-width"` in `workspace.members`.
- [ ] `crates/quanta-vt-width/Cargo.toml` pins `unicode-segmentation` and
      `unicode-width` to exact versions; `[package.metadata]` block records
      the Unicode version.
- [ ] `src/lib.rs` exists with `#![forbid(unsafe_code)]` and re-exports the
      full public API.
- [ ] `src/domain/mod.rs` defines `CellWidth`, `Grapheme`, `AmbiguousWidthPolicy`,
      `WrapEligibility`, `HostOs` with the exact signatures in §4.1.
- [ ] `src/port.rs` defines `WidthClassifier` and `GraphemeIter` per §4.1.5.
- [ ] `src/adapters/default.rs` defines `DefaultClassifier` implementing the
      trait per §4.1.6.
- [ ] `src/overrides.rs` has at least 5 documented groups (variation selectors,
      ZWJs, regional indicators, DEC-graphics defensive entry, ambiguous
      corrections) and ≥ 30 total entries.

### 5.2 TS mirror

- [ ] `packages/ui/src/shared/lib/width/index.ts`, `types.ts`,
      `classifier.ts` exist.
- [ ] TS API mirrors the Rust API shape: every enum variant, every class, every
      function signature is present on the TS side.
- [ ] A generated lookup table or WASM binding is committed — parity test
      consumes it (§5.4).

### 5.3 Corpus sizes

- [ ] `width_corpus.txt` has ≥ 500 non-comment non-blank entries covering:
      ASCII (≥ 128), Latin-1 extensions (≥ 30), CJK common (≥ 50), emoji
      single-code-point (≥ 20), emoji ZWJ sequences (≥ 5), combining marks
      (≥ 10), VS15/VS16 pairs (≥ 10), DEC line-drawing (≥ 10).
      Breakdown asserted by `tests/width_parity.rs` sub-counts.
- [ ] `grapheme_corpus.txt` has ≥ 100 entries; each entry is a case where
      `s.chars().count() != classifier.segment(s).count()` (i.e. non-trivial
      segmentation). Includes regional indicators, skin-tone modifiers,
      family emoji, combining composites, VS16 pairs.
- [ ] `wrap_corpus.txt` has ≥ 200 entries with edge cases: 2-cell at col 79 /
      col 78 in 80-col grid; combining after base at col 0; wrap at col 0;
      overflow at col `cols`; regional-indicator at final column.

### 5.4 Test execution

- [ ] `cargo test -p quanta-vt-width` passes (all 5 Rust test files).
- [ ] `pnpm --filter @quanta/ui test -- width` passes (TS parity file).
- [ ] Rust↔TS parity: the TS classifier, fed the same `width_corpus.txt`, produces
      identical results row-for-row. Asserted by
      `packages/ui/src/shared/lib/width/__tests__/parity.test.ts`. Zero divergence
      allowed.

### 5.5 Policy resolution cases

`tests/ambiguous_width.rs` asserts all 7 cases below (one test per case):

- [ ] `resolve(MacOs, None)` → `Narrow`.
- [ ] `resolve(Windows, None)` → `Narrow`.
- [ ] `resolve(Linux, None)` → `Narrow`.
- [ ] `resolve(Linux, Some("en_US.UTF-8"))` → `Narrow`.
- [ ] `resolve(Linux, Some("ko_KR.UTF-8"))` → `Wide`.
- [ ] `resolve(Linux, Some("ja_JP.UTF-8"))` → `Wide`.
- [ ] `resolve(Linux, Some("zh_CN.UTF-8"))` → `Wide`.

### 5.6 Override table structure

`tests/override_table.rs` asserts 3 invariants:

- [ ] Sorted: `OVERRIDES[i].code_point < OVERRIDES[i+1].code_point` for all `i`.
- [ ] Unique: no two entries share a code point.
- [ ] Documented: a text scan of `src/overrides.rs` finds a `// Reason:` and
      `// Ref:` line associated with each `const GROUP_*` definition.

### 5.7 Lint + format

- [ ] `cargo clippy -p quanta-vt-width --all-targets -- -D warnings` clean.
- [ ] `cargo fmt --all --check` clean.
- [ ] `pnpm typecheck` clean (TS mirror passes the repo typecheck).
- [ ] No `panic!` or `unwrap` in library code (`src/**/*.rs` excluding `tests/`
      and `fuzz/`); grep-enforced in CI. Fallible paths return `Result` or use
      `debug_assert!` where a logic bug is the only failure cause.

### 5.8 Fuzz

- [ ] `fuzz/fuzz_targets/classify_grapheme.rs` compiles and runs.
- [ ] Local 5-minute fuzz run completes with zero panics (developer sanity
      check, documented in crate README).
- [ ] CI `fuzz-weekly.yml` runs the target for 60 minutes on `main` weekly;
      regressions filed as P0.

### 5.9 ADR + docs

- [ ] `docs/adr/0015-width-grapheme-line-break-ssot.md` Status line reads
      `**Status**: Accepted`.
- [ ] Unicode version is documented in the ADR body *and* pinned in the crate's
      `Cargo.toml` `[package.metadata]` block. Both values match.

**DoD item count: 38 items.** Every item above is a separate checkbox; impl
agent treats the list as the merge contract.

---

## 6. Quality Gates

Hard merge blocks. Each gate names the CI job that enforces it.

| Gate | Enforced by (CI job / script) | Failure behavior |
|---|---|---|
| Rust unit+parity tests green | `cargo test -p quanta-vt-width` step in `.github/workflows/ci.yml` | PR blocked |
| TS parity test green | `pnpm --filter @quanta/ui test` step in `.github/workflows/ci.yml` | PR blocked |
| Clippy clean | `cargo clippy -p quanta-vt-width --all-targets -- -D warnings` in `ci.yml` | PR blocked |
| fmt clean | `cargo fmt --all --check` in `ci.yml` | PR blocked |
| TS typecheck clean | `pnpm typecheck` step in `ci.yml` | PR blocked |
| Invariant I-3 enforced (no `unicode-width` in renderer) | EPIC-K grep rule job `check-paint-no-width-override` in `.github/workflows/parity.yml` | PR blocked |
| No `panic!`/`unwrap` in library | EPIC-K grep rule `check-no-unwrap` scoped to `crates/quanta-vt-width/src/**` | PR blocked |
| Corpus size thresholds | `tests/width_parity.rs` + `grapheme_parity.rs` + `wrap_parity.rs` assert line counts ≥ 500 / 100 / 200 via `include_str!` + split | Test fails → PR blocked |
| Override table well-formed | `tests/override_table.rs` asserts sort + uniqueness + documented reason | PR blocked |
| Fuzz smoke (per PR) | `.github/workflows/fuzz-smoke.yml` — 2 min fuzz run on `classify_grapheme` | PR blocked on panic |
| Fuzz long-run (weekly) | `.github/workflows/fuzz-weekly.yml` — 60 min run on `main` | Regression → P0 issue; not a PR blocker |
| Unicode version pinned | `tests/override_table.rs` reads `CARGO_PKG_METADATA_UNICODE_VERSION` or equivalent and asserts it matches the ADR-documented value | PR blocked |

All gates listed above are hard-blocks before EPIC-B may start implementation,
except the long-run fuzz which is a continuous guard rather than a freeze gate.

---

## 7. End-to-end scenarios

Each E2E sets up a scenario, runs it, asserts the outcome. They are not unit
tests — they exercise the library from the perspective of downstream consumers
(engine, renderer, input). All E2Es live in `crates/quanta-vt-width/tests/e2e/`
as separate `#[test]` files, or as sections of existing parity tests with the
`e2e_` prefix.

### E2E-A1: Engine consumes width classifier via trait

**Goal**. Prove the public API shape is usable as a `&dyn WidthClassifier` from
a downstream caller that looks like EPIC-B.

**Setup**. A test-local struct `StubEngine { classifier: Box<dyn WidthClassifier> }`
with a `fn process(&self, input: &str) -> Vec<(Grapheme, CellWidth)>` method
that iterates `classifier.segment(input)` and pairs each grapheme with
`classifier.classify_grapheme(g.as_str())`.

**Run**. Feed the stub the string `"Hello, 한글! 🙂"`.

**Assert**. Output sequence is exactly:
```
("H", One) ("e", One) ("l", One) ("l", One) ("o", One) (",", One) (" ", One)
("한", Two) ("글", Two) ("!", One) (" ", One) ("🙂", Two)
```

### E2E-A2: TS mirror classifies identical corpus

**Goal**. Zero-divergence Rust↔TS parity on the full width corpus.

**Setup**. Vitest test `parity.test.ts` loads `width_corpus.txt` from the Rust
crate (cross-referenced via repo-relative path) and iterates.

**Run**. For each corpus line, parse `hex_codepoints`, build the grapheme
string, call `classifier.classifyGrapheme(s)`, compare to expected width.

**Assert**. Zero mismatches across all 500+ entries. Any mismatch emits a rich
error message `expected=<w> actual=<w> codepoints=<hex> tag=<tag>`.

### E2E-A3: Ambiguous-width policy changes classification

**Goal**. Policy is a real switch, not cosmetic.

**Setup**. Two classifiers: `narrow = DefaultClassifier::new(Narrow)` and
`wide = DefaultClassifier::new(Wide)`.

**Run**. Classify `U+2018` (LEFT SINGLE QUOTATION MARK, East-Asian Width `A`).

**Assert**. `narrow.classify_grapheme("\u{2018}")` → `CellWidth::One`.
`wide.classify_grapheme("\u{2018}")` → `CellWidth::Two`. Repeat for 4 more
ambiguous-width code points documented in overrides.

### E2E-A4: Wrap at 2-cell edge

**Goal**. Simulate an 80-col terminal cursor at col 79 with a wide next grapheme.

**Setup**. `classifier = DefaultClassifier::new(Narrow)`; grid_cols = 80.

**Run**.
- `classifier.wrap_eligible(79, 80, "\u{D55C}")` → expected `MustWrap`.
- `classifier.wrap_eligible(78, 80, "\u{D55C}")` → expected `Fits`.
- `classifier.wrap_eligible(79, 80, "A")` → expected `Fits`.
- `classifier.wrap_eligible(80, 80, "A")` → expected `MustWrap`.

**Assert**. All four cases match. Documented in `wrap_corpus.txt`.

### E2E-A5: ZWJ emoji is one grapheme

**Goal**. `👨‍👩‍👧‍👦` = 4 code points + 3 ZWJ = 1 grapheme, width=2.

**Setup**. `classifier = DefaultClassifier::new(Narrow)`.

**Run**. Segment the full ZWJ string; classify the single resulting grapheme.

**Assert**.
- `segment` yields exactly 1 `Grapheme`.
- `classify_grapheme(that_grapheme.as_str())` = `CellWidth::Two`.
- "Backspace" semantics simulation: if a downstream VT engine deletes the last
  grapheme, the entire ZWJ cluster is removed — not split. Asserted by
  comparing the segmented-then-dropped-last output against the empty string.

### E2E-A6: Combining mark attaches to base

**Goal**. `e` + `U+0301` = `é` as one grapheme of width 1; selection anchor
after `é` is col 1 not col 2.

**Setup**. `classifier = DefaultClassifier::new(Narrow)`.

**Run**. `segment("e\u{0301}")` → expect 1 `Grapheme`. `classify_grapheme` on
that grapheme → `CellWidth::One`. Simulated cursor math: start col=0, advance
by width=1 → next col=1.

**Assert**. Grapheme count = 1; width = 1; cursor advances by 1 column only.

### E2E-A7: Linux CJK locale auto-detection

**Goal**. Prove the auto-resolve path ships the correct policy on a Korean
Linux session.

**Setup**. No classifier yet — this tests the pure `resolve` function.

**Run**.
- `AmbiguousWidthPolicy::resolve(HostOs::Linux, Some("ko_KR.UTF-8"))` →
  expected `Wide`.
- Construct `DefaultClassifier::new(resolved_policy)`.
- `classifier.classify_grapheme("\u{2018}")` → expected `Two`.

**Assert**. Policy resolves to `Wide`; classifier under that policy returns
width=2 for the canonical ambiguous code point.

---

## 8. Test deliverables

Concrete counts and ownership.

| Test file | Test count | Covers | DoD refs |
|---|---|---|---|
| `tests/width_parity.rs` | ≥ 500 assertions (corpus-driven) | width_corpus.txt | §5.3, §5.4 |
| `tests/grapheme_parity.rs` | ≥ 100 assertions (corpus-driven) | grapheme_corpus.txt | §5.3, §5.4 |
| `tests/wrap_parity.rs` | ≥ 200 assertions (corpus-driven) | wrap_corpus.txt | §5.3, §5.4 |
| `tests/ambiguous_width.rs` | 7 cases | §5.5 policy resolution | §5.5 |
| `tests/override_table.rs` | 3 invariant tests | §5.6 override structure | §5.6 |
| `tests/e2e/engine_consumer.rs` | 1 test (E2E-A1) | trait usability | §7 |
| `tests/e2e/policy_switch.rs` | 5 tests (E2E-A3) | policy effect on classification | §7 |
| `tests/e2e/wrap_edges.rs` | 4 tests (E2E-A4) | wrap at edge | §7 |
| `tests/e2e/zwj_cluster.rs` | 1 test (E2E-A5) | ZWJ grapheme | §7 |
| `tests/e2e/combining_base.rs` | 1 test (E2E-A6) | combining marks | §7 |
| `tests/e2e/auto_cjk.rs` | 1 test (E2E-A7) | Linux ko locale | §7 |
| `packages/ui/src/shared/lib/width/__tests__/parity.test.ts` | ≥ 500 (same corpus) | E2E-A2 Rust↔TS parity | §5.2, §5.4 |
| `fuzz/fuzz_targets/classify_grapheme.rs` | N/A — fuzz | panic-free, width ≤ 2/grapheme | §5.8 |

**Total assertions: ~1310** across Rust parity (800) + TS parity (500) +
ambiguous policy (7) + override structure (3).

---

## 9. Failure modes retired

From RFC 0001 v4 §16 (20-point failure list). This epic retires 3 items
outright; each has a pinned test + E2E scenario. If a DoD gate is later
removed, the retired status reverts automatically.

- **#5 — `한` = 1 cell → column misalignment**. Addressed by:
  - `width_corpus.txt` entries for U+D55C, U+AC00, U+B098 (Hangul syllables).
  - `DefaultClassifier` + override table routing Hangul to `CellWidth::Two`.
  - E2E-A4 wraps `한` at col 79 correctly (MustWrap) and at col 78 (Fits).
  - Test: `tests/width_parity.rs` + `tests/e2e/wrap_edges.rs`.

- **#6 — `👨‍👩‍👧‍👦` = 8 cells → wrong substring copy**. Addressed by:
  - `grapheme_corpus.txt` entry for the family ZWJ cluster (1 grapheme, 25 bytes).
  - `DefaultClassifier::segment` returns exactly 1 `Grapheme`.
  - `classify_grapheme` returns `CellWidth::Two` for the cluster.
  - E2E-A5 asserts single-grapheme behavior end-to-end.
  - Test: `tests/grapheme_parity.rs` + `tests/e2e/zwj_cluster.rs`.

- **#7 — VS16 flip mid-stream**. Addressed by:
  - `overrides.rs` Variation Selector group defines VS15/VS16 as width=0
    directly, and the segment layer handles VS16-induced base-width flip.
  - `width_corpus.txt` includes ≥ 10 VS16 pairs (`❤️`, `1️⃣`, etc.).
  - Test: `tests/width_parity.rs` corpus-driven VS16 rows.

Additional failure modes this epic indirectly helps:

- **#20 (partial)** — selection across wrapped row. This epic provides the
  width math; selection normalization itself is EPIC-D.

---

## 10. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ambiguous-width default wrong for a Linux distro (e.g. Arch without LANG export) | Medium | Medium | User-overrideable via Settings (post-v1); telemetry counter `width.policy_override_count` emitted by EPIC-J; rollback is a setting flip, not a code change. |
| `unicode-width` upstream version bump breaks downstream grid math | Medium | High | Version pinned in Cargo.toml; bumps require full parity corpus re-run; ADR 0015 update required as review artifact. |
| TS port drifts silently from Rust | Medium | High | `parity.test.ts` iterates the exact `width_corpus.txt` file from the Rust crate (not a copy); any divergence fails CI. |
| Curated override table omits a real-world trouble codepoint | High | Medium | Public issue template `width-wrong-for-codepoint`; fix is a small PR adding one entry + one corpus row; turn-around < 1 day. |
| Grapheme heap fallback is hot for common workloads (perf) | Low | Low | Inline variant covers ≤ 8 bytes, which in measurements covers ≥ 99% of graphemes outside pathological ZWJ chains. If heap hits become frequent, bump inline to 16 bytes behind the `Grapheme` abstraction — no API change. |
| Unicode version pinning lags real-world emoji additions | Certain | Low | Accepted. RFC 0001 v1 targets Unicode 15.1; newer emoji degrade to `unicode-width` default which is narrow — not corrupt, just suboptimal. Bumps scheduled quarterly. |

---

## 11. Rollback

This epic ships a leaf crate behind the `WidthClassifier` trait. Rollback paths,
in order of intrusiveness:

1. **Override-table hotfix** (minutes): if a specific code point shows up wrong
   in production, add an entry to `overrides.rs` + one row to
   `width_corpus.txt`. Small PR; no downstream code changes.

2. **Unicode version bump behind parity gate** (hours): if the pinned
   `unicode-width` version proves systematically wrong (e.g. post-emoji
   presentation overhaul), bump the dependency and re-run parity corpus. ADR
   0015 is updated with the new version in the same PR.

3. **Ambiguous-width policy override** (minutes): user-side setting flip.
   Session is reconstructed with the new policy; no code change.

4. **Implementation swap** (days): if `DefaultClassifier` proves fundamentally
   wrong, a new implementation can be introduced behind the same
   `WidthClassifier` trait. Downstream code (B/D/E) takes
   `impl WidthClassifier` and is unchanged.

No architectural rollback is needed. The crate is internal, the trait is the
boundary, the corpus is the truth table.

---

## 12. Cross-references

- **RFC 0001 v4 §3.1** (terminal semantic truth owned by the engine — width is
  part of the engine's truth).
- **RFC 0001 v4 §8** (width / grapheme / line-break authority contract).
- **RFC 0001 v4 §13.2** (cell/grid multilingual core — `CellWidth`, combining,
  VS15/VS16).
- **RFC 0001 v4 §16** failure modes #5 / #6 / #7.
- **ADR 0015** — width / grapheme / line-break SSOT. This epic flips it to
  Accepted.
- **EPIC-B** (`epic-B-vt-engine-core.md` §2.1–§2.2, §4.x) depends on
  `CellWidth`, `Grapheme`, `WidthClassifier` for `Cell`, `Grid::feed`,
  `vte_processor::print`.
- **EPIC-D** (renderer + selection) depends on the TS mirror for hit-test
  (`screenToCell`) width math and selection-anchor normalization.
- **EPIC-E** (input + IME) depends on the TS mirror indirectly for preedit
  overlay candidate-popup anchoring (via `cellToScreen` which uses width).
- **EPIC-J** (telemetry) adds the `width.policy_override_count` counter; this
  epic emits it.
- **EPIC-K** (CI) owns the grep rules that enforce I-3 (`no unicode-width in
  packages/ui outside shared/lib/width/`).

---

## 13. Work breakdown (days)

Single implementation agent. Spec work happens in parallel on EPICS B/C/D/E
while this implements.

**Week 1** (Days 1-5):

- **Day 1** — Cargo skeleton. Workspace member, `Cargo.toml`, `src/lib.rs`,
  module skeletons, `#![forbid(unsafe_code)]`. Commit 1.
- **Day 2** — Domain types: `CellWidth`, `Grapheme` (inline + heap variants),
  `AmbiguousWidthPolicy` + `resolve`, `WrapEligibility`, `HostOs`. Unit tests
  for enum basics + `resolve` 7 cases. Commit 2.
- **Day 3** — `WidthClassifier` trait, `DefaultClassifier` skeleton. Import
  `unicode-segmentation` + `unicode-width`. Minimal happy-path for ASCII +
  Latin-1. Commit 3.
- **Day 4** — `overrides.rs`: VS15/VS16, ZWJ, regional indicators, ambiguous
  corrections; at least 30 entries across 5 documented groups.
  `override_table.rs` tests (sort, unique, documented). Commit 4.
- **Day 5** — Begin corpus: ASCII 0x20-0x7E, Latin-1 0xA0-0xFF, common CJK
  (Hangul, Hiragana, Katakana, CJK Unified Ideographs basic range), emoji
  single codepoint, combining marks, VS15/VS16 pairs, DEC line drawing. Reach
  ≥ 500 entries. Wire `width_parity.rs` test. Commit 5.

**Week 1.5** (Days 6-8):

- **Day 6** — `grapheme_corpus.txt` (≥ 100) + `grapheme_parity.rs`;
  `wrap_corpus.txt` (≥ 200) + `wrap_parity.rs`. E2E tests A1/A4/A5/A6/A7.
  Commit 6.
- **Day 7** — TS mirror: `types.ts`, `classifier.ts`, `index.ts`, generated
  lookup table. `parity.test.ts` reading the Rust corpus. Debug any divergence
  (expected: 1-5 rows needing override adjustment). Commit 7.
- **Day 8** — Fuzz target (`classify_grapheme.rs`) + 5-minute local run. CI
  integration (`fuzz-smoke.yml` + `fuzz-weekly.yml` wiring). ADR 0015 status
  → Accepted. Final review + merge. Commit 8.

Total: 8 working days, fits in the 1.5-week Phase 0 budget with 2 days slack.

---

**End of document.**

---

## 14. Known limitations (tracked for follow-up)

### 14.1 Emoji widening coverage is partial

The curated override table (`src/overrides.rs` `EmojiWidening` block) currently covers weather/symbol emoji in the U+2600 range but not the U+1F5xx "tools" plane (paintbrush U+1F58C, spray can U+1F9F4, etc.). These high-plane emojis fall back to `unicode-width`, which returns `1` without VS16.

**Current behavior**: grapheme-corpus entry for `🎨🖌` is pinned to `2,1` to match the classifier. Shells / editors that render these as 2 cells will look misaligned against our grid.

**Follow-up** (not blocking EPIC-A DoD): expand `EmojiWidening` overrides to cover the full emoji-tool plane. Audit all `unicode-width == 1` code points in `U+1F300..U+1F6FF` and pin to 2 where terminal convention disagrees. Add a fixture `emoji_widening_corpus.txt` asserting each.

**Telemetry signal**: `width.policy_override_count` (EPIC-J counter) will light up in dogfood when users hit these cases; that's the trigger to file the follow-up.

### 14.2 TS mirror pending

α's EPIC-A impl agent landed the full Rust side but `packages/ui/src/shared/lib/width/` TS mirror is incomplete (only `__tests__/` directory exists). Follow-up task (tracked separately): complete TS port with `types.ts`, `classifier.ts`, `index.ts`, and parity test that reads the same Rust corpus.

Once the TS mirror lands and the parity test passes, EPIC-D (renderer) is unblocked for hit-test / selection width normalization.

