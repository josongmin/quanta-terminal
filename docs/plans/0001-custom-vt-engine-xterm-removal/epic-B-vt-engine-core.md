# EPIC-B — VT Engine Core — Detailed Design

- **Status**: Design-ahead draft (Gear 3)
- **Date**: 2026-04-19
- **Scope owner**: EPIC-B spec agent
- **Implements**: RFC 0001 §7, §8, §9, §13.1-13.7, §13.10, §16
- **Depends on**: EPIC-A (`CellWidth`, `Grapheme`, `WidthClassifier`, `AmbiguousWidthPolicy` — frozen by ADR 0015)
- **Freezes**: `EventEnvelope<P>`, `TerminalEvent`, `Grid::feed`, `TerminalModeState` (per ADR 0017, epic-plan Freeze 2)
- **Out-of-scope**: wire format (EPIC-C), session wiring (EPIC-F), input encoder impl (EPIC-E), renderer (EPIC-D).

This document produces the type contracts, module layout, state machines, and
test plan that EPIC-B implementation will code against. No Rust under
`crates/` is touched. See §14 for how downstream epics integrate.

---

## 1. Module layout

All paths are under `crates/quanta-vt/src/`. The tree mirrors ADR 0014
hexagonal layout: `domain/` is pure value types, `ports/` is traits,
`adapters/` is anything that talks to an external crate (here: `vte`).

```
crates/quanta-vt/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── domain/
│   │   ├── mod.rs
│   │   ├── cell.rs
│   │   ├── grid.rs
│   │   ├── cursor.rs
│   │   ├── sgr.rs
│   │   ├── charset.rs
│   │   ├── modes.rs
│   │   ├── color.rs
│   │   └── mode_state.rs
│   ├── ports/
│   │   ├── mod.rs
│   │   ├── event.rs
│   │   └── input.rs
│   └── adapters/
│       ├── mod.rs
│       ├── vte_processor.rs
│       ├── grid_renderer.rs
│       └── damage_tracker.rs
├── tests/
│   ├── unit/…            (see §12)
│   ├── grid_invariants.rs
│   ├── golden_streams.rs
│   └── ordering.rs
└── fuzz/fuzz_targets/vte_process.rs
```

### 1.1 File-by-file

#### `src/lib.rs`
Crate entry. `#![forbid(unsafe_code)]`. Re-exports the public surface:
`Grid`, `Cell`, `Cursor`, `TerminalEvent`, `EventEnvelope`,
`TerminalModeState`, `BufferKind`, `Color`, `TerminalInput`.
**No business logic.**

#### `src/domain/mod.rs`
Module aggregator. Declares `mod cell; mod grid; mod cursor; mod sgr;
mod charset; mod modes; mod color; mod mode_state;` and `pub use` the
public value types.

#### `src/domain/cell.rs`
The atomic unit. Holds the grapheme cluster, `CellWidth` from EPIC-A,
SGR attributes (bitflags), foreground and background `Color`, optional
hyperlink id. A wide char's right half is represented as a sibling `Cell`
with `CellWidth::Zero` and `WIDE_CONTINUATION` attribute set.

- Public symbols: `Cell`, `CellAttrs` (bitflags struct), `HyperlinkId`.
- Imports from EPIC-A: `CellWidth`, `Grapheme`.

#### `src/domain/grid.rs`
The engine. Holds main buffer, alt buffer, scrollback ring, cursor,
SGR state, charset state, `Modes` bitfield, `TerminalModeState`, damage
tracker, row revisions, epoch and sequence counters. Public entry is
`Grid::feed(&mut self, &[u8]) -> Vec<TerminalEvent>` per RFC §7 diagram.

- Public symbols: `Grid`, `GridSnapshot`, `GridDelta`, `RowDelta`,
  `BufferKind`, `Rect`.
- Imports from EPIC-A: `CellWidth`, `WidthClassifier`,
  `AmbiguousWidthPolicy`.

#### `src/domain/cursor.rs`
Cursor position + shape + visibility + save/restore stacks (main and
alt have independent stacks). Implements DECSC/DECRC chain.

- Public symbols: `Cursor`, `CursorShape`, `CursorSave`.
- No EPIC-A imports.

#### `src/domain/sgr.rs`
The current SGR "pen" — the attributes and colors that will be written
into the next `Cell`. `CSI 0 m` fully resets; `CSI m` with no params is
an alias for `CSI 0 m` (xterm behavior).

- Public symbols: `SgrState`, `CellAttrs` (re-exported from `cell.rs`).
- No EPIC-A imports.

#### `src/domain/charset.rs`
G0-G3 slots plus single-shift (SS2/SS3). Maps DEC special graphics (`0`
designator, commonly `ESC ( 0`) code points to Unicode box-drawing
characters. Applied at `print` time before grapheme accumulation.

- Public symbols: `CharsetState`, `CharsetSlot`, `CharsetTable`.
- No EPIC-A imports.

#### `src/domain/modes.rs`
`Modes` struct, one bit per DEC private mode we track. Backed by two
`u128`s (256 bits; we use ~20 in v1, rest reserved). Mirrors the
`TerminalModeState` update path (§4 of ADR 0017) — `Modes` is the
authoritative storage; `TerminalModeState` is the snapshot read surface.

- Public symbols: `Modes`, `DecMode` (enum of known modes),
  `UnknownModeAction { Emit, Ignore }`.
- No EPIC-A imports.

#### `src/domain/color.rs`
`Color` enum: `Default`, `Palette8(u8)` (0..15 ANSI), `Palette256(u8)`,
`TrueColor { r, g, b }`. Inline representation; 4 bytes including tag
so two colors per cell fit cleanly.

- Public symbols: `Color`, `NamedColor`.
- No EPIC-A imports.

#### `src/domain/mode_state.rs`
`TerminalModeState` — the snapshot struct that the input encoder reads
per ADR 0017 §4. Produced by `Grid::mode_snapshot()`; never live-read.

- Public symbols: `TerminalModeState`, `KittyKeyboardLevel`,
  `MouseProtocol`, `MouseEncoding`.
- No EPIC-A imports.

#### `src/ports/mod.rs`
Declares `mod event; mod input;` and re-exports public traits and
payload types.

#### `src/ports/event.rs`
`TerminalEvent` enum with payload structs. `EventEnvelope<P>` generic
wrapper carrying `grid_epoch`, `sequence_no`, `buffer_kind`,
`resize_generation` (ADR 0017 §1).

- Public symbols: `TerminalEvent`, `EventEnvelope<P>`, `SessionId`,
  `GridSnapshot`, `GridDelta`, `RowDelta`, `CellRun`.
- No EPIC-A imports.

#### `src/ports/input.rs`
`TerminalInput` trait — interface EPIC-E will implement. Kept here to
freeze the contract; implementation lives in a different crate.

- Public symbols: `TerminalInput`, `KeyEvent`, `MouseEvent`,
  `PasteEvent`, `FocusEvent`.
- No EPIC-A imports.

#### `src/adapters/mod.rs`
Declares `mod vte_processor; mod grid_renderer; mod damage_tracker;`.

#### `src/adapters/vte_processor.rs`
Wraps `vte::Parser` and implements `vte::Perform`. All byte-stream
interpretation lives here; domain code never sees raw bytes. This is the
only file that imports `vte`.

- Public symbols: `VteProcessor`.
- Imports from EPIC-A: `WidthClassifier` (via `Grid` reference).

#### `src/adapters/damage_tracker.rs`
Per-row revision counters, rect damage for scroll regions, cursor delta
and mode delta queues. Coalesces multiple writes to the same row within
one `feed()`.

- Public symbols: `DamageTracker`, `RowDamage`, `RectDamage`.
- No EPIC-A imports.

#### `src/adapters/grid_renderer.rs`
Computes `GridDelta` from the damage tracker snapshot at the end of a
`feed()` call. Emits `CellsChanged` payloads. Not a "renderer" in the UI
sense — it's a diff computer. Name mirrors RFC §7 block diagram.

- Public symbols: `GridRenderer`, `RenderOutput`.
- No EPIC-A imports.

---

## 2. Public type contracts

**Convention**: all public types derive `Debug, Clone` unless noted.
Enums with discriminants derive `PartialEq, Eq`. Payloads implement
`serde::Serialize, serde::Deserialize` so EPIC-C can ship them over the
wire without re-definition.

### 2.1 `Cell`

```rust
// src/domain/cell.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    pub grapheme: Grapheme,        // EPIC-A; empty for WIDE_CONTINUATION
    pub width: CellWidth,          // EPIC-A; Zero = right-half or combining
    pub fg: Color,
    pub bg: Color,
    pub attrs: CellAttrs,
    pub hyperlink: Option<HyperlinkId>,
}

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
    pub struct CellAttrs: u16 {
        const BOLD               = 1 <<  0;
        const DIM                = 1 <<  1;
        const ITALIC             = 1 <<  2;
        const UNDERLINE          = 1 <<  3;
        const BLINK              = 1 <<  4;
        const INVERSE            = 1 <<  5;
        const INVISIBLE          = 1 <<  6;
        const STRIKETHROUGH      = 1 <<  7;
        const DOUBLE_UNDERLINE   = 1 <<  8;
        const CURLY_UNDERLINE    = 1 <<  9;
        const OVERLINE           = 1 << 10;
        const WIDE_CONTINUATION  = 1 << 11; // this cell is the right half of a 2-cell grapheme
        const DIRTY              = 1 << 12; // internal; cleared on flush
        // bits 13-15 reserved
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HyperlinkId(pub u32);

impl Cell {
    pub const EMPTY: Cell;          // space, default colors, no attrs
    pub fn is_wide_right(&self) -> bool;
    pub fn is_continuation(&self) -> bool;
}
```

### 2.2 `Color`

```rust
// src/domain/color.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    Default,
    Palette8(u8),        // 0..=15 (bright bit baked in)
    Palette256(u8),
    TrueColor { r: u8, g: u8, b: u8 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedColor {
    Black, Red, Green, Yellow, Blue, Magenta, Cyan, White,
    BrightBlack, BrightRed, /* … */
}
```

### 2.3 `SgrState`

```rust
// src/domain/sgr.rs
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SgrState {
    pub fg: Color,
    pub bg: Color,
    pub attrs: CellAttrs,
    pub hyperlink: Option<HyperlinkId>,
}

impl SgrState {
    pub const DEFAULT: SgrState;
    /// Apply one SGR param-list; chainable.
    pub fn apply(&mut self, params: &vte::Params);
    /// CSI 0 m — full reset. Also triggered by empty params per xterm.
    pub fn reset(&mut self);
    /// Read into a freshly allocated cell, stamping current pen state.
    pub fn stamp(&self, cell: &mut Cell);
}
```

### 2.4 `Cursor`

```rust
// src/domain/cursor.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
    pub shape: CursorShape,
    pub blink: bool,
    pub pending_wrap: bool, // DECAWM: set when last write was at last col
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorShape {
    Block, BlockBlink, Underline, UnderlineBlink, Bar, BarBlink,
}

#[derive(Debug, Clone)]
pub struct CursorSave {
    pub cursor: Cursor,
    pub sgr: SgrState,
    pub charset: CharsetState,
    pub origin_mode: bool,
}

impl Cursor {
    pub fn clamp(&mut self, rows: u16, cols: u16);
    pub fn advance(&mut self, cells: u16, cols: u16) -> bool; // returns overflow
    pub fn newline(&mut self, top: u16, bottom: u16);
}
```

### 2.5 `CharsetState`

```rust
// src/domain/charset.rs
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CharsetState {
    pub g0: CharsetTable,
    pub g1: CharsetTable,
    pub g2: CharsetTable,
    pub g3: CharsetTable,
    pub gl: CharsetSlot,    // active GL slot (typically G0)
    pub gr: CharsetSlot,    // active GR slot (typically G1)
    pub single_shift: Option<CharsetSlot>, // cleared after one char (SS2/SS3)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharsetSlot { G0, G1, G2, G3 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CharsetTable {
    #[default]
    Ascii,
    DecSpecialGraphics, // ESC ( 0 — box drawing
    Uk,                 // ESC ( A — deferred
}

impl CharsetState {
    pub fn translate(&mut self, c: char) -> char;
}
```

### 2.6 `Modes`

```rust
// src/domain/modes.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modes {
    flags_lo: u128,  // DEC private modes 1..=128
    flags_hi: u128,  // 129..=256
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum DecMode {
    CursorKey         = 1,    // DECCKM
    Origin            = 6,    // DECOM
    AutoWrap          = 7,    // DECAWM
    CursorVisible     = 25,   // DECTCEM
    ReverseWrap       = 45,
    AltScreenBuffer   = 47,
    MouseX10          = 9,
    MouseButton       = 1000,
    MouseDrag         = 1002,
    MouseAny          = 1003,
    FocusReport       = 1004,
    MouseUtf8         = 1005,  // deferred: legacy UTF-8 encoding
    MouseSgr          = 1006,
    AltScreenAlt      = 1047,
    SaveCursor        = 1048,
    AltScreenFull     = 1049,
    BracketedPaste    = 2004,
    SyncUpdate        = 2026,
    // 1034, 1036 (metaSendsEscape) tracked as unknown_dec_mode in v1.
}

impl Modes {
    pub fn is_set(&self, m: DecMode) -> bool;
    pub fn set(&mut self, m: DecMode, on: bool);
    /// For unknown modes → bumps counter, no state change.
    pub fn note_unknown(&mut self, code: u16);
}
```

### 2.7 `TerminalModeState`

Per ADR 0017 §4. This is what EPIC-E reads *as a snapshot*, never live.

```rust
// src/domain/mode_state.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TerminalModeState {
    pub cursor_key_app: bool,            // DECCKM
    pub bracketed_paste: bool,           // 2004
    pub focus_report: bool,              // 1004
    pub mouse_protocol: MouseProtocol,
    pub mouse_encoding: MouseEncoding,
    pub modify_other_keys: u8,           // 0, 1, or 2
    pub kitty_keyboard: KittyKeyboardLevel,
    pub alt_screen: bool,
    pub sync_update: bool,               // 2026 active
    pub auto_wrap: bool,                 // DECAWM
    pub origin: bool,                    // DECOM
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseProtocol {
    #[default] Off,
    X10,      // 9
    Button,   // 1000
    Drag,     // 1002
    Any,      // 1003
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseEncoding {
    #[default] Legacy,
    Sgr,      // 1006
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KittyKeyboardLevel {
    #[default] Disabled,
    L1, L2, L3,
}

impl TerminalModeState {
    pub fn snapshot_from(modes: &Modes) -> TerminalModeState;
}
```

### 2.8 `BufferKind`

```rust
// src/ports/event.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferKind { Main, Alt }
```

### 2.9 `EventEnvelope<P>` (ADR 0017 §1)

```rust
// src/ports/event.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventEnvelope<P> {
    pub session_id: SessionId,
    pub grid_epoch: u64,
    pub sequence_no: u64,
    pub buffer_kind: BufferKind,
    pub resize_generation: u64,
    pub payload: P,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(pub uuid::Uuid);
```

### 2.10 `TerminalEvent`

Exhaustive variant list per RFC §7 and epic-plan freeze list.

```rust
// src/ports/event.rs
#[derive(Debug, Clone, PartialEq)]
pub enum TerminalEvent {
    GridSnapshot(GridSnapshot),
    GridDelta(GridDelta),
    CursorMoved(CursorPayload),
    ModeChanged(ModeChangedPayload),
    TitleChanged(String),
    CwdChanged(String),
    BellRequested,
    HyperlinkOpened { id: HyperlinkId, uri: String, params: Option<String> },
    HyperlinkClosed { id: HyperlinkId },
    ClipboardRequest(ClipboardPayload),
    OscPassthrough { code: u16, data: Vec<u8> },  // 133 shell integration, etc.
    ClearScrollback,
    Resize { rows: u16, cols: u16, resize_generation: u64 },
    SynchronizedUpdate(SyncUpdatePayload),
    UnknownCsi  { final_byte: u8, intermediates: Vec<u8>, params: Vec<u16> },
    UnknownOsc  { code: u16 },
    UnknownDecMode { code: u16, set: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub struct GridSnapshot {
    pub rows: u16,
    pub cols: u16,
    pub buffer_kind: BufferKind,
    pub cells: Vec<Vec<Cell>>,            // rows-major; length == rows
    pub continuations: Vec<bool>,         // per-row continuation flag
    pub row_revisions: Vec<u64>,
    pub cursor: CursorPayload,
    pub modes: TerminalModeState,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct GridDelta {
    pub row_deltas: Vec<RowDelta>,        // only rows that changed
    pub rect_damage: Vec<RectDamage>,     // scroll regions
    pub scrollback_appended: u32,         // rows appended to scrollback
}

#[derive(Debug, Clone, PartialEq)]
pub struct RowDelta {
    pub row: u16,
    pub revision: u64,
    pub runs: Vec<CellRun>,               // contiguous cells with identical attrs
    pub continuation: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CellRun {
    pub start_col: u16,
    pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RectDamage {
    pub top: u16, pub left: u16, pub bottom: u16, pub right: u16,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorPayload {
    pub row: u16, pub col: u16,
    pub visible: bool,
    pub shape: CursorShape,
    pub pending_wrap: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModeChangedPayload {
    pub state: TerminalModeState,
    pub changed: Vec<DecMode>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClipboardPayload {
    Set { selection: u8, data: String },   // OSC 52
    Query { selection: u8 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum SyncUpdatePayload { Begin, End, Timeout }
```

### 2.11 `Grid` — the one that freezes

```rust
// src/domain/grid.rs
pub struct Grid { /* private */ }

impl Grid {
    /// Construct a new grid. `scrollback_cap` is in rows. `classifier` is
    /// EPIC-A's `WidthClassifier`; passed as `Arc` so EPIC-F can share one
    /// instance across all sessions.
    pub fn new(
        rows: u16,
        cols: u16,
        scrollback_cap: usize,
        classifier: std::sync::Arc<dyn WidthClassifier>,
    ) -> Grid;

    /// Feed PTY bytes. Returns all events emitted during this feed, in
    /// order. Damage is flushed at the end of the call.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<TerminalEvent>;

    /// Resize. Bumps `resize_generation`. Emits `Resize` + a new
    /// `GridSnapshot`. No-op if (rows, cols) unchanged.
    pub fn resize(&mut self, rows: u16, cols: u16) -> Vec<TerminalEvent>;

    /// Full state snapshot. Used on connect, resume, divergence resync.
    pub fn snapshot(&self) -> GridSnapshot;

    /// Per-row revision counter. Mirror uses this to detect mismatch.
    pub fn row_revision(&self, row: u16) -> Option<u64>;

    /// Which buffer is active (Main or Alt).
    pub fn active_buffer(&self) -> BufferKind;

    /// Current mode state snapshot — consumed by EPIC-E input encoder.
    pub fn mode_snapshot(&self) -> TerminalModeState;

    /// Current epoch and sequence. Exposed so EPIC-F wrapping can stamp
    /// EventEnvelopes without looking inside the grid.
    pub fn epoch(&self) -> u64;
    pub fn next_sequence(&mut self) -> u64;

    /// Bump epoch (reconnect, buffer re-init). Triggers next feed to
    /// start with a `GridSnapshot`.
    pub fn reinit_epoch(&mut self);
}
```

### 2.12 `TerminalInput` trait

Frozen here so EPIC-E can code against it. No default impl.

```rust
// src/ports/input.rs
pub trait TerminalInput: Send + Sync {
    fn encode_key(&self, event: &KeyEvent, modes: &TerminalModeState) -> Vec<u8>;
    fn encode_mouse(&self, event: &MouseEvent, modes: &TerminalModeState) -> Vec<u8>;
    fn encode_paste(&self, event: &PasteEvent, modes: &TerminalModeState) -> Vec<u8>;
    fn encode_focus(&self, event: &FocusEvent, modes: &TerminalModeState) -> Vec<u8>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyEvent {
    pub key: KeySym,
    pub modifiers: Modifiers,
    pub text: Option<String>,  // dead-key / IME commit payload
    pub repeat: bool,
}

// KeySym, Modifiers, MouseEvent, PasteEvent, FocusEvent: concrete shapes
// defined in EPIC-E's spec. Here we only reserve the names.
```

---

## 3. Invariant audit (RFC 0001 §2)

| Inv. | Text (abridged) | Enforcement in EPIC-B | Test(s) | CI check |
|------|-----------------|-----------------------|---------|----------|
| I-1  | Exactly one VT engine | `Grid::feed` is the sole public entry point for PTY bytes. No other crate takes raw bytes. | `tests/ordering.rs::feed_is_sole_entry` (compile-time: `vte` only imported in `adapters/vte_processor.rs`). | EPIC-K grep rule `tools/check-ui-no-ansi/` already bans ANSI parsing outside `crates/quanta-vt/`; we add a rule banning `vte::` imports outside `adapters/`. |
| I-2  | UI does not parse ANSI | `TerminalEvent` is the exported surface; nothing in this crate exports raw-byte APIs. | n/a (UI-side) | EPIC-K grep rule. |
| I-3  | Grid is the truth | `Grid` owns cells, widths, cursor, buffer; no mutator crosses the boundary. Public API returns `Cell` values by ref, never `&mut`. | `tests/grid_invariants.rs::grid_is_only_mutator_property` (proptest: any sequence of `feed` leaves `snapshot().cells` == recomputation). | Clippy deny `pub_use_of_crate_private_item`. |
| I-4  | Semantic width wins | Width derived from `WidthClassifier` at `print` time; no per-cell width override API. `Cell::width` is `pub` but never settable bypassing the classifier. | `tests/unit/grapheme.rs::width_from_classifier`. | EPIC-K grep rule `tools/check-paint-no-width-override/`. |
| I-5  | Delta from day one | `Grid::feed` returns `TerminalEvent` stream; steady-state emits `GridDelta`, not `GridSnapshot`. Snapshot only emitted by `snapshot()`, `resize()`, `reinit_epoch()`. | `tests/ordering.rs::steady_state_is_delta_only`. | Test-time assertion on telemetry counter `snapshot_fallback_count`. |
| I-6  | Input encoder non-optional | Out-of-scope (EPIC-E). Here we only expose `TerminalInput` trait; no direct byte-emit path from DOM. | n/a | n/a |
| I-7  | IME preedit never enters grid | Out-of-scope (EPIC-E). `Grid::feed` only accepts committed bytes. | n/a | n/a |
| I-8  | No black screen | `snapshot()` is pure; never fails. Last-snapshot retention is EPIC-H's job. | `tests/grid_invariants.rs::snapshot_never_panics`. | n/a |
| I-9  | Ordered reducer stream | Every emitted event passes through `next_sequence()`; epoch fenced by `reinit_epoch()`. | `tests/ordering.rs::sequence_strictly_ascending`, `epoch_bumps_fence`. | n/a |
| I-10 | xterm removed last | n/a (EPIC-I). | n/a | n/a |

---

## 4. State machines

### 4.1 Alt-screen swap (DECSET 1049 / 1047 / 1048)

```
                 ┌─────────────────┐
   start ───────▶│  Main, no save  │
                 └────────┬────────┘
                          │
          DECSET 1048  (save cursor only, no swap)
                          ▼
                 ┌─────────────────┐
                 │ Main, save = S₀ │
                 └────────┬────────┘
                          │
          DECSET 1047  (enter alt, NO cursor save)
                          ▼
                 ┌─────────────────┐
                 │ Alt, save = S₀  │◀── DECRESET 1047 (exit alt, keep save)
                 └────────┬────────┘         ▲
                          │                   │ ModeChanged(AltScreen=false)
          DECSET 1049  (save + clear alt + enter)
                          │
                 ┌────────▼────────┐
                 │ Alt, save = S₁  │
                 │ alt cleared     │
                 └────────┬────────┘
                          │
          DECRESET 1049 (exit alt, restore cursor from S₁)
                          ▼
                 ┌─────────────────┐
                 │ Main, save = ∅  │
                 └─────────────────┘
```

**Ordering guarantee (RFC §9.2)**: the `ModeChanged(AltScreen=…)` event
is emitted BEFORE any cell-delta of the destination buffer in the same
`feed()` call. Damage tracker enforces this by flushing the mode change
first.

### 4.2 SGR reset chain

```
      any SgrState ─── CSI 0 m ──▶ SgrState::DEFAULT
      any SgrState ─── CSI m   ──▶ SgrState::DEFAULT   (xterm alias)
      any SgrState ─── CSI n m ──▶ apply(n), chain to next param
                                   (n = 1..9 attrs, 30-37 fg, 40-47 bg,
                                    38;5;N / 38;2;r;g;b truecolor, 22-28 reset-attr, 39/49 default color)
```

Pseudocode:

```
fn apply(&mut self, params: &Params) {
    if params.is_empty() || params.len() == 1 && params[0] == [0] { self.reset(); return; }
    let mut iter = params.iter();
    while let Some(p) = iter.next() {
        match p[0] {
            0 => self.reset(),
            1 => self.attrs |= BOLD,
            22 => self.attrs &= !(BOLD | DIM),
            30..=37 => self.fg = Palette8(p[0] - 30),
            38 => self.fg = parse_extended(&mut iter),  // 5;N or 2;r;g;b
            39 => self.fg = Default,
            40..=47 => self.bg = Palette8(p[0] - 40),
            90..=97 => self.fg = Palette8(p[0] - 90 + 8), // bright
            _ => { /* unknown_sgr counter */ }
        }
    }
}
```

### 4.3 Charset shift

```
                ┌─────────────┐    ESC ( 0     ┌──────────────────────┐
   start ──────▶│ G0=ASCII    │───────────────▶│ G0=DecSpecialGraphics│
                │ G1=ASCII    │                │ G1=ASCII             │
                │ GL=G0 GR=G1 │                │ GL=G0 GR=G1          │
                └──────┬──────┘                └──────┬───────────────┘
                       │                              │
                       │ ESC N (SS2)                  │  print 'q'  (→ ─ horizontal line)
                       ▼                              │
                ┌─────────────────┐                   │
                │ single_shift=G2 │                   │
                └──────┬──────────┘                   │
                       │ one print consumes SS        │
                       ▼                              │
                ┌─────────────────┐                   │
                │ single_shift=∅  │                   │
                └─────────────────┘                   │
                                                       ▼
                                             ┌─────────────────┐
                                             │ print 'l' → ┌   │
                                             │ print 'k' → ┐   │
                                             └─────────────────┘
```

Lookup order at `print(c)`: `single_shift` if set → slot named by
`single_shift` (consume); else GL (most bytes < 0x80) or GR (bytes
≥ 0x80, rare in v1). Table translates ASCII range only; Unicode above
0x7F flows through untranslated.

### 4.4 Cursor visibility + shape

```
                    ┌───────────────────────────┐
        start ─────▶│ visible=true shape=Block  │
                    └──────┬────────────────────┘
                           │  DECRESET 25
                           ▼
                    ┌───────────────────────────┐
                    │ visible=false             │
                    └──────┬────────────────────┘
                           │  DECSET 25
                           ▼
                    ┌───────────────────────────┐
                    │ visible=true              │
                    └───────────────────────────┘

         shape transitions (CSI n SP q, DECSCUSR):
           0 or 1 → BlockBlink
           2      → Block
           3      → UnderlineBlink
           4      → Underline
           5      → BarBlink
           6      → Bar
```

### 4.5 Synchronized update (DECSET 2026, BSU/ESU via DCS)

```
            ┌─────────────────┐
  start ───▶│ SyncUpdate=off  │
            └────────┬────────┘
                     │  DECSET 2026  OR  DCS = 1 $ q (BSU)
                     ▼
            ┌──────────────────────────┐
            │ SyncUpdate=on            │
            │ damage buffered          │
            │ timer armed (150 ms)     │
            └────────┬─────────────────┘
                     │
      ┌──────────────┼──────────────────┐
      │              │                  │
      ▼              ▼                  ▼
  DECRESET 2026   DCS = 2 $ q       timer expires
   (ESU clean)     (ESU clean)      (Timeout — emit what we have)
      │              │                  │
      └──────────┬───┴──────────────────┘
                 ▼
         ┌───────────────────────────┐
         │ emit accumulated GridDelta│
         │ state → SyncUpdate=off    │
         └───────────────────────────┘
```

**Budget**: 150 ms hard cap. On timeout we emit with
`SynchronizedUpdate::Timeout` and move on; telemetry counts it.

---

## 5. DEC mode coverage (RFC §8 table, expanded)

**v1 set**. Anything not listed routes to `UnknownDecMode { code, set }`
and bumps `unknown_dec_mode` counter.

| Mode | Name | Summary | Storage | Perform | Emits | Test |
|------|------|---------|---------|---------|-------|------|
| 1    | DECCKM | Cursor-key application mode | `Modes::CursorKey` + `TerminalModeState.cursor_key_app` | `csi_dispatch` `?1h/?1l` | `ModeChanged` | `dec_mode_1.rs` |
| 6    | DECOM | Origin mode — cursor constrained to scroll region | `Modes::Origin` + `TerminalModeState.origin` | `csi_dispatch` `?6h/?6l` | `ModeChanged` | `dec_mode_6.rs` |
| 7    | DECAWM | Auto-wrap | `Modes::AutoWrap` | `csi_dispatch` `?7h/?7l` | `ModeChanged` | `dec_mode_7.rs` |
| 9    | MouseX10 | Legacy X10 mouse | `Modes::MouseX10` + `TerminalModeState.mouse_protocol=X10` | `csi_dispatch` `?9h/?9l` | `ModeChanged` | `dec_mode_9.rs` |
| 25   | DECTCEM | Cursor visible | `Modes::CursorVisible` + `cursor.visible` | `csi_dispatch` `?25h/?25l` | `ModeChanged` + `CursorMoved` | `dec_mode_25.rs` |
| 45   | ReverseWrap | Reverse-wraparound | `Modes::ReverseWrap` | `csi_dispatch` `?45h/?45l` | `ModeChanged` | `dec_mode_45.rs` |
| 47   | AltScreenBuffer | Alt-screen (no cursor save) | `Modes::AltScreenBuffer`  + `TerminalModeState.alt_screen` | `csi_dispatch` `?47h/?47l` | `ModeChanged`, then buffer swap | `alt_screen.rs::mode_47_*` |
| 1000 | MouseButton | Button-down mouse | `Modes::MouseButton` + `TerminalModeState.mouse_protocol=Button` | `csi_dispatch` `?1000h/?1000l` | `ModeChanged` | `dec_mode_1000.rs` |
| 1002 | MouseDrag | Button-event tracking | `Modes::MouseDrag` | `csi_dispatch` | `ModeChanged` | `dec_mode_1002.rs` |
| 1003 | MouseAny | Any-event tracking | `Modes::MouseAny` | `csi_dispatch` | `ModeChanged` | `dec_mode_1003.rs` |
| 1004 | FocusReport | Emit focus events | `Modes::FocusReport` + `TerminalModeState.focus_report` | `csi_dispatch` | `ModeChanged` | `dec_mode_1004.rs` |
| 1006 | MouseSgr | SGR mouse encoding | `Modes::MouseSgr` + `TerminalModeState.mouse_encoding=Sgr` | `csi_dispatch` | `ModeChanged` | `dec_mode_1006.rs` |
| 1047 | AltScreenAlt | Alt-screen (clear on exit) | `Modes::AltScreenAlt` | `csi_dispatch` | `ModeChanged`, buffer swap | `alt_screen.rs::mode_1047_*` |
| 1048 | SaveCursor | Save/restore cursor only | `Cursor::save_stack` | `csi_dispatch` | `CursorMoved` | `alt_screen.rs::mode_1048_*` |
| 1049 | AltScreenFull | Save cursor + enter alt + clear alt | composite: `Modes::AltScreenFull` + `CursorSave` | `csi_dispatch` | `ModeChanged`, `CursorMoved`, buffer swap | `alt_screen.rs::mode_1049_*` |
| 2004 | BracketedPaste | Bracketed paste | `Modes::BracketedPaste` + `TerminalModeState.bracketed_paste` | `csi_dispatch` | `ModeChanged` | `dec_mode_2004.rs` |
| 2026 | SyncUpdate | Synchronized update | `Modes::SyncUpdate` + `TerminalModeState.sync_update` | `csi_dispatch` + DCS `$q` | `SynchronizedUpdate::Begin/End/Timeout` | `sync_update.rs` |

Non-v1 (emit `UnknownDecMode`, bump counter):

```rust
// deferred: 1005 (legacy UTF-8 mouse — obsoleted by SGR 1006)
// deferred: 1015 (URXVT mouse — non-standard)
// deferred: 1034 (metaSendsEscape — encoder concern, not grid)
// deferred: 1036 (altSendsEscape — encoder concern)
// deferred: 12  (att610 blinking cursor — shape concern)
// deferred: 40  (allow 80→132 mode — we pin 80×24 semantics)
// deferred: 66  (DECNKM numeric keypad — encoder concern)
// deferred: 69  (DECLRMM left-right margin — reflow too invasive for v1)
// deferred: 1004 extended (focus-report level 2 — v2)
// deferred: all kitty-keyboard CSI = ? N u (tracked via kitty_keyboard field, but flag set under its own protocol; not a DEC private mode)
```

---

## 6. OSC handler coverage

All OSC dispatches route through `osc_dispatch(params, bell_terminated)`.
Params are `&[&[u8]]`; first element is the code as ASCII digits.

| OSC | Name | Semantic | Event | Test |
|-----|------|----------|-------|------|
| 0   | Icon + Title | Set icon name and window title | `TitleChanged(s)` | `osc_0.rs` |
| 2   | Title | Set window title only | `TitleChanged(s)` | `osc_2.rs` |
| 4   | Palette | Set/query palette color N | `OscPassthrough { code: 4, data }` for v1 (query response needs output channel; deferred set handling to EPIC-F) | `osc_4.rs` |
| 7   | CWD | Set current working directory (URI-encoded) | `CwdChanged(decoded)` | `osc_7.rs` |
| 8   | Hyperlink | Start/end hyperlink region | `HyperlinkOpened/HyperlinkClosed` | `osc_8.rs` |
| 10  | FG | Set default foreground | `OscPassthrough { code: 10, data }` | `osc_10.rs` |
| 11  | BG | Set default background | `OscPassthrough { code: 11, data }` | `osc_11.rs` |
| 12  | CursorColor | Set cursor color | `OscPassthrough { code: 12, data }` | `osc_12.rs` |
| 52  | Clipboard | Set/query clipboard (selection, base64 data) | `ClipboardRequest(Set/Query)` | `osc_52.rs` |
| 104 | ResetPalette | Reset palette entries | `OscPassthrough { code: 104, data }` | `osc_104.rs` |
| 105 | ResetPaletteAll | Reset all palette | `OscPassthrough { code: 105, data }` | `osc_105.rs` |
| 133 | ShellIntegration | A (prompt), B (end prompt), C (command start), D (command end) | `OscPassthrough { code: 133, data }` — EPIC-F consumer parses subcodes | `osc_133.rs` |

### 6.1 Handler skeletons (pseudocode)

```rust
fn osc_dispatch(&mut self, params: &[&[u8]], bell_terminated: bool) {
    let code = parse_u16(params.first().copied().unwrap_or(b""));
    match code {
        Some(0) | Some(2) => {
            let title = utf8_lossy(params.get(1).unwrap_or(&b""[..]));
            self.emit(TerminalEvent::TitleChanged(title));
        }
        Some(7) => {
            let raw = utf8_lossy(params.get(1).unwrap_or(&b""[..]));
            match percent_decode(&raw) {
                Ok(cwd) => self.emit(TerminalEvent::CwdChanged(cwd)),
                Err(_)  => self.bump_counter("osc_7_bad_encoding"),
            }
        }
        Some(8) => {
            // params: b"8", b"id=abc;key=val;...", b"<uri>"
            let params_field = params.get(1).copied().unwrap_or(&b""[..]);
            let uri = utf8_lossy(params.get(2).unwrap_or(&b""[..]));
            if uri.is_empty() {
                self.close_current_hyperlink();
            } else {
                let id = self.alloc_hyperlink_id();
                self.emit(TerminalEvent::HyperlinkOpened { id, uri, params: parse_osc8_params(params_field) });
                self.sgr.hyperlink = Some(id);
            }
        }
        Some(52) => { /* selection + base64 payload → ClipboardRequest */ }
        Some(133) => self.emit(TerminalEvent::OscPassthrough { code: 133, data: concat(params) }),
        Some(c @ (10 | 11 | 12 | 4 | 104 | 105)) => {
            self.emit(TerminalEvent::OscPassthrough { code: c, data: concat(params) });
        }
        Some(c) => { self.emit(TerminalEvent::UnknownOsc { code: c }); self.bump_counter("unknown_osc"); }
        None    => { self.bump_counter("osc_bad_code"); }
    }
}
```

---

## 7. Damage tracking design

### 7.1 Row revisions

Flat `Vec<u64>` of length `rows + scrollback_len`. Index 0 is the
top-most visible row; indices `rows..rows + scrollback_len` are
scrollback (growing downward in the vec; the ring is a `VecDeque<Row>`
and `row_revisions` is kept in lockstep).

Every mutation to row R bumps `row_revisions[R] += 1`. Resize rebuilds
the vec to the new length and bumps every entry (revisions always only
go up).

### 7.2 When revisions increment

- `print(grapheme)` at row R → +1 for R.
- `execute(LF)` — scrolls → every row in scroll region gets +1.
- `CSI J` / `CSI K` — every affected row +1.
- Scroll-up / scroll-down (CSI S / T, or LF with cursor at bottom) —
  every row in scroll region +1; also rect damage for the region.
- `resize(…)` — every row +1 (forces mirror refresh).
- Alt-screen enter/exit — every row of the destination buffer +1.

### 7.3 Rect damage

Scroll regions use `RectDamage { top, left, bottom, right, revision }`.
Rect damage is additive to row deltas — mirror applies rect first (a
memmove-equivalent) then row deltas on top for the re-inked rows.

Implementation: `DamageTracker` accumulates a `Vec<RectDamage>` during
the `feed()` call. Coalescing: adjacent rects for the same scroll region
within one feed merge (union).

### 7.4 Flush policy — **commit: flush at end of feed**

`Grid::feed(bytes)` consumes all bytes, computes one `GridDelta` from
accumulated damage, and returns events in this order:

1. `ModeChanged` (if modes changed — includes alt-screen swap)
2. `Resize` (if resize happened — rare inside feed; usually from
   `resize()` call path)
3. `GridDelta` (the accumulated cell damage)
4. `CursorMoved` (final cursor state, if changed since last feed)
5. `TitleChanged` / `CwdChanged` / `BellRequested` / `HyperlinkOpened`
   / `HyperlinkClosed` / `ClipboardRequest` / `OscPassthrough` (in the
   order they were observed in the byte stream)
6. `SynchronizedUpdate::End` (if sync was active)
7. `UnknownCsi` / `UnknownOsc` / `UnknownDecMode` (telemetry tail)

Justification: this mirrors Alacritty's frame-accumulator model, gives
RFC §13.13 a clean "parse/apply" budget (= one `feed()` call), and
satisfies I-5 (delta only).

### 7.5 Coalescing

Multiple writes to the same `Cell` within one feed → only the **final**
state ships. Implementation: `DamageTracker` marks row `DIRTY` but
doesn't duplicate runs; the end-of-feed pass reads current cell values
directly from the grid, not a write log. Coalescing is therefore free.

---

## 8. Scrollback ring design

### 8.1 Choice: `VecDeque<Row>` with fixed capacity

Pick: `VecDeque<Row>`, `push_back` + `pop_front` when length exceeds
`scrollback_cap`. Justification:

- True ring requires a head index and masked addressing; adds ~1%
  overhead to every row read with zero memory win.
- `VecDeque` is already `O(1)` front-pop, back-push.
- Iteration order matches row indexing (scrollback row 0 = oldest,
  `scrollback.len() - 1` = most recent scrolled-off).

`Row` = `Vec<Cell>` (length == `cols` at write time) + `continuation: bool`.

### 8.2 Wrap vs explicit-`\n`

Per row: `continuation: bool`. `true` means "this row is a soft-wrap
continuation of the previous row". `false` means "this row ended with
LF or was hard-terminated by ED/EL".

**Storage**: `continuation` is a `bool` sibling to each row. Copy on
scroll, emit in `RowDelta`.

**Invariant**: the first row in scrollback is always
`continuation: false` (we never scroll off into a wrap fragment). When
a row about to be popped has `continuation: true` but the row *after* it
is `continuation: true` too, we only pop if popping also pops the
whole continuation run. Implementation: ring is conceptually "logical
lines" but stored as physical rows; on eviction we walk forward until
the next `continuation: false`.

### 8.3 Resize behavior

Non-continuation rows: truncate or pad (space-fill) to `cols_new`. No
reflow.

Continuation runs: identify the run (a sequence of rows where first
has `continuation:false` and successors `continuation:true`); extract
the logical line (concatenate graphemes in order); rewrap to `cols_new`
using `WidthClassifier::wrap_eligible`.

Edge: if `cols_new` is huge, a run that was 10 rows may collapse to 1.
Conversely, a 1-row logical line may expand to 10. See §10.

### 8.4 Memory bound

Per-cell budget:

- `Grapheme` — SmallString inline 8 bytes + 8-byte length/cap = 16 bytes
  (EPIC-A freeze; ZWJ families spill to heap but tracked as a warning
  in telemetry).
- `CellWidth` — 1 byte (padded to 1).
- `Color fg` + `Color bg` — 5 bytes + 5 bytes = 10 bytes.
- `CellAttrs` — 2 bytes.
- `HyperlinkId` — 4 bytes (Option: 8 with niche).

≈ 40 bytes per cell with padding → 44.

For **10,000 scrollback × 120 cols**:
`10,000 × 120 × 44 = 52.8 MB`.

This exceeds the RFC §13.12 budget (22 MB). **Mitigation** (also an
open question — see §13):

- Inline-empty-row optimization: an unmodified row holds `None` for its
  cells vector until written → drops the typical `yes | head`-style
  stream to `Vec::new()` after scrolling.
- Run-length store for scrollback: `Vec<CellRun>` instead of
  `Vec<Cell>`; uniform-color rows collapse dramatically (a typical
  terminal row is 1-3 runs).

**Estimate with run-length + empty-row optimization**:
10,000 × 120 × 44 × 0.15 (typical compression) ≈ 8 MB. Within budget.

Implementation: `Row::Dense(Vec<Cell>)` | `Row::Runs(Vec<CellRun>)`;
scrollback rows are stored as `Runs`, active-buffer rows as `Dense`.
Conversion happens at scroll-out time.

---

## 9. `vte::Perform` impl sketch

`VteProcessor` owns a `&mut Grid` for the duration of a `feed()` call
(actually a `Parser::advance` loop under the hood). All methods mutate
`Grid` through its internal API; no state lives in `VteProcessor` itself
beyond the active grapheme accumulator.

### 9.1 `print(c: char)` — hot path

```rust
fn print(&mut self, c: char) {
    let translated = self.grid.charset.translate(c);
    // single-shift consumed on any printable char, including combining
    self.grid.charset.single_shift = None;

    self.grapheme_acc.push(translated);
    if let Some((cluster, width)) = self.grapheme_acc.try_flush(&*self.grid.classifier) {
        self.grid.write_grapheme(cluster, width);
    }
}
```

### 9.2 `execute(byte: u8)` — control bytes

```rust
fn execute(&mut self, byte: u8) {
    self.flush_grapheme_acc();
    match byte {
        0x07 => self.grid.emit(BellRequested),
        0x08 => self.grid.cursor_backspace(),                     // BS
        0x09 => self.grid.cursor_horizontal_tab(),                // HT
        0x0A | 0x0B | 0x0C => self.grid.line_feed(),              // LF/VT/FF
        0x0D => self.grid.cursor_carriage_return(),               // CR
        0x0E => self.grid.charset.gl = G1,                        // SO
        0x0F => self.grid.charset.gl = G0,                        // SI
        _    => { /* noop; bump counter */ }
    }
}
```

### 9.3 `hook` / `put` / `unhook` — DCS

Used for DEC synchronized-update protocol (`DCS = 1 $ q` begin,
`DCS = 2 $ q` end). `hook` initializes a DCS accumulator, `put` appends
bytes, `unhook` dispatches based on the accumulated DCS command.

```rust
fn hook(&mut self, params: &Params, ints: &[u8], _: bool, action: char) {
    self.dcs = Some(DcsAccumulator::new(params, ints, action));
}
fn put(&mut self, byte: u8) { if let Some(a) = &mut self.dcs { a.push(byte) } }
fn unhook(&mut self) {
    if let Some(a) = self.dcs.take() {
        match a.kind() {
            DcsKind::SyncBegin => self.grid.sync_begin(),
            DcsKind::SyncEnd   => self.grid.sync_end(),
            DcsKind::Unknown   => self.grid.bump("unknown_dcs"),
        }
    }
}
```

### 9.4 `osc_dispatch` — see §6.

### 9.5 `csi_dispatch` — the big match

Dispatch by `(intermediates, final_byte, private)`. Each branch calls a
small helper on `Grid`. Unknown → `UnknownCsi` event.

```rust
fn csi_dispatch(&mut self, params: &Params, ints: &[u8], ignore: bool, action: char) {
    self.flush_grapheme_acc();
    if ignore { self.grid.bump("csi_ignored"); return; }
    let private = ints.first().copied() == Some(b'?');
    match (private, action, ints) {
        (false, 'A', _) => self.grid.cursor_up(params),
        (false, 'B', _) => self.grid.cursor_down(params),
        (false, 'C', _) => self.grid.cursor_right(params),
        (false, 'D', _) => self.grid.cursor_left(params),
        (false, 'H', _) | (false, 'f', _) => self.grid.cursor_position(params),
        (false, 'J', _) => self.grid.erase_in_display(params),
        (false, 'K', _) => self.grid.erase_in_line(params),
        (false, 'm', _) => self.grid.sgr.apply(params),
        (false, 'r', _) => self.grid.set_scroll_region(params),
        (false, 'S', _) => self.grid.scroll_up(params),
        (false, 'T', _) => self.grid.scroll_down(params),
        (false, 'q', [b' ']) => self.grid.cursor_shape(params),   // DECSCUSR
        (true,  'h', _) => self.grid.dec_set(params, true),
        (true,  'l', _) => self.grid.dec_set(params, false),
        // … ~40 more …
        _ => self.grid.emit(UnknownCsi { final_byte: action as u8, ... }),
    }
}
```

### 9.6 `esc_dispatch` — charset, SS2/SS3, DECSC/DECRC

```rust
fn esc_dispatch(&mut self, ints: &[u8], _: bool, byte: u8) {
    self.flush_grapheme_acc();
    match (ints, byte) {
        ([b'('], desig) => self.grid.charset.g0 = designator_to_table(desig),
        ([b')'], desig) => self.grid.charset.g1 = designator_to_table(desig),
        ([b'*'], desig) => self.grid.charset.g2 = designator_to_table(desig),
        ([b'+'], desig) => self.grid.charset.g3 = designator_to_table(desig),
        ([], b'N')       => self.grid.charset.single_shift = Some(G2),  // SS2
        ([], b'O')       => self.grid.charset.single_shift = Some(G3),  // SS3
        ([], b'7')       => self.grid.save_cursor(),                     // DECSC
        ([], b'8')       => self.grid.restore_cursor(),                  // DECRC
        ([], b'D')       => self.grid.line_feed(),                       // IND
        ([], b'M')       => self.grid.reverse_index(),                   // RI
        ([], b'E')       => { self.grid.cursor_cr(); self.grid.line_feed(); } // NEL
        ([], b'c')       => self.grid.ris(),                             // RIS — full reset
        _                => self.grid.bump("unknown_esc"),
    }
}
```

### 9.7 Grapheme accumulator algorithm

**Key design decision**: grapheme boundaries are detected on the **second**
character that *would* start a new cluster, not on cluster completion.
This matches `unicode-segmentation`'s streaming API.

State:

```rust
struct GraphemeAccumulator {
    buf: String,             // code points accumulated so far
    buf_width: CellWidth,    // running width estimate (updated on flush)
}

impl GraphemeAccumulator {
    fn push(&mut self, c: char);

    /// Called after every `push`. Uses EPIC-A's `WidthClassifier` to
    /// test whether the accumulated buffer is a complete cluster AND
    /// whether appending the next-observed code point would open a new
    /// cluster. Returns Some((cluster, width)) if the *previous*
    /// cluster is now confirmed-complete.
    fn try_flush(&mut self, cls: &dyn WidthClassifier) -> Option<(Grapheme, CellWidth)>;

    /// Forced flush: called before any non-print event (execute, CSI,
    /// OSC, resize). Flushes whatever is in the buffer even if
    /// technically unfinished; equivalent to "stream boundary".
    fn flush(&mut self, cls: &dyn WidthClassifier) -> Option<(Grapheme, CellWidth)>;
}
```

Algorithm (streaming boundary detection):

1. On each `push(c)`, append to `buf`.
2. Probe `WidthClassifier::is_cluster_boundary(buf)` (EPIC-A exposes a
   boundary predicate keyed on the *last two* code points).
3. If boundary is detected AT the new char:
   - Slice `buf` into `(completed_cluster, remaining = [c])`.
   - Compute `cls.width(completed_cluster)`.
   - Return `Some((Grapheme::new(completed_cluster), width))`.
   - Retain `remaining` in `buf` as the start of the next cluster.
4. If no boundary: accumulate and wait.
5. On `flush`: if `buf.is_empty()` return None, else compute width on
   whatever's there and return.

Edge cases:

- **Combining mark at start** (e.g., lone `U+0301`): `unicode-segmentation`
  treats as a single-cluster (degenerate). EPIC-A's classifier returns
  `CellWidth::Zero`; we store as a combining attachment to the cell at
  cursor-1 if such exists (via `Grid::attach_combining`), else skip with
  `grapheme_degenerate` counter.
- **ZWJ mid-cluster**: push continues until ZWJ-join-sequence
  terminates; no flush in between.
- **VS16 flip**: a variation selector after a base char forms a joined
  cluster; EPIC-A's width table handles the +1 override.

Forced-flush triggers: `execute`, `csi_dispatch`, `esc_dispatch`,
`osc_dispatch`, `hook`, `put`, `unhook`, `resize`. Any non-`print` call
flushes first to preserve ordering (otherwise a CSI mid-cluster could
reorder against the grapheme).

---

## 10. Resize / reflow algorithm

```rust
pub fn resize(&mut self, rows_new: u16, cols_new: u16) -> Vec<TerminalEvent> {
    if rows_new == 0 || cols_new == 0 {
        // Reject — degenerate geometry. Emit Unknown + no-op.
        self.emit(UnknownCsi { /* synthetic */ }); return out;
    }
    if (rows_new, cols_new) == (self.rows, self.cols) { return vec![]; }

    // 1. Flush any pending grapheme to current cursor position.
    self.flush_grapheme_acc();

    // 2. Main buffer reflow.
    if self.active == BufferKind::Main {
        let logical_lines = extract_logical_lines(&self.main_rows);
        let (new_rows, new_cont) = rewrap(logical_lines, cols_new, &*self.classifier);
        self.main_rows = new_rows;
        self.main_continuation = new_cont;
    } else {
        // Alt buffer: no reflow. Clip or pad to new dims.
        for row in &mut self.alt_rows {
            row.resize(cols_new as usize, Cell::EMPTY);
        }
        self.alt_rows.resize(rows_new as usize, Row::empty(cols_new));
    }

    // 3. Cursor clamp.
    self.cursor.row = self.cursor.row.min(rows_new - 1);
    self.cursor.col = self.cursor.col.min(cols_new - 1);
    self.cursor.pending_wrap = false; // DECAWM state discarded on resize

    // 4. Row revisions: bump all.
    self.row_revisions.resize(rows_new as usize, 0);
    for r in &mut self.row_revisions { *r += 1; }

    // 5. Generation + events.
    self.resize_generation += 1;
    self.rows = rows_new; self.cols = cols_new;

    out.push(TerminalEvent::Resize {
        rows: rows_new, cols: cols_new,
        resize_generation: self.resize_generation,
    });
    out.push(TerminalEvent::GridSnapshot(self.snapshot()));
    out
}
```

### 10.1 `rewrap` helper

Input: `Vec<LogicalLine>` where each `LogicalLine` is a flat
`Vec<Cell>` (concatenation of a `continuation`-run).

For each logical line:

1. Walk cells left-to-right, summing `CellWidth` into `col`.
2. For each cell, test `wrap_eligible(prev_grapheme, this_grapheme)`
   (EPIC-A); if wrap is forced (2-cell at `cols_new - 1`) or the cell
   would overflow (`col + width > cols_new`): close the current physical
   row, open a new one with `continuation: true`.
3. Preserve trailing blanks only if the logical line ended
   `continuation: false` AND was shorter than `cols_new`.

Output: `(Vec<Row>, Vec<bool>)` where lengths are equal.

### 10.2 Edge cases

- **Logical line of 10,000 wrapped rows**: `extract_logical_lines`
  allocates one `Vec<Cell>` of size up to `10,000 × old_cols`; this is
  the worst case for reflow memory and allocates `~4.8 MB` temporarily.
  Acceptable for v1; noted in §13 as an open question for v2
  (streaming reflow).
- **Shrink mid-continuation-run**: no special handling — the cells are
  in the logical line; `rewrap` produces more physical rows.
- **Grow mid-continuation**: cells rejoin into fewer physical rows.
- **Cursor was in a continuation row**: cursor position recomputed
  by finding the Nth grapheme of its original logical line in the new
  row layout. Simplified: we clamp row to `rows_new - 1` and preserve
  column — acceptable because reflow during active typing is rare and
  the upstream PTY will re-render.
- **Resize during alt-screen**: alt-buffer is clipped/padded (no
  reflow). On exit back to main, main reflow state is preserved.

---

## 11. Fuzz target design

```rust
// fuzz/fuzz_targets/vte_process.rs
fuzz_target!(|data: &[u8]| {
    let mut grid = Grid::new(24, 80, 1_000, default_classifier());
    for chunk in data.chunks(64) {
        let _events = grid.feed(chunk);
    }
    assert_invariants(&grid);
});

fn assert_invariants(g: &Grid) {
    let snap = g.snapshot();
    assert_eq!(snap.cells.len(), g.rows() as usize);
    assert!(snap.cursor.row < g.rows());
    assert!(snap.cursor.col < g.cols());
    assert!(g.scrollback_len() <= g.scrollback_cap());
    assert_eq!(snap.row_revisions.len(), g.rows() as usize + g.scrollback_len());
    // Revisions monotonic: fuzzer keeps a shadow, checks every delta.
}
```

**Invariants asserted**:

1. `feed` never panics (any bytes, any length).
2. `snap.cells.len() == rows` post-feed.
3. `cursor.row ∈ [0, rows)` ∧ `cursor.col ∈ [0, cols)`.
4. `scrollback_len ≤ scrollback_cap`.
5. `row_revisions.len() == rows + scrollback_len`.
6. Every emitted `TerminalEvent` has `sequence_no` strictly greater than
   the last (fuzz harness wraps each event in an envelope and checks).
7. Per-row revision monotonic (never decreases within an epoch).
8. `modes.is_set(AltScreen) == (active_buffer == Alt)` (buffer/mode
   agreement).

**CI duration**: 60 minutes on every main-branch merge; 5 minutes on
every PR touching `crates/quanta-vt/`. Any panic → P0 regression.

---

## 12. Test list

### 12.1 Unit tests (per-file coverage)

| File | Covers | Case count |
|------|--------|------------|
| `tests/unit/sgr.rs` | SGR parse, reset, chained attrs, 16/256/truecolor, reset-chain, CSI m alias | 40+ |
| `tests/unit/csi_cursor.rs` | CUP / CUD / CUU / CUF / CUB, clamping, origin mode, pending_wrap | 25+ |
| `tests/unit/csi_ed.rs` | ED 0/1/2/3, EL 0/1/2, rect erase DECERA | 12+ |
| `tests/unit/csi_scroll.rs` | SU / SD / scroll-region r, IL / DL | 15+ |
| `tests/unit/dec_modes.rs` | one test per DEC mode in §5 | 17 |
| `tests/unit/osc_0.rs` / `osc_2.rs` | title, unicode title | 6 |
| `tests/unit/osc_4.rs` | palette set/query | 4 |
| `tests/unit/osc_7.rs` | cwd URI decode, malformed | 5 |
| `tests/unit/osc_8.rs` | hyperlink open/close/nested/id reuse | 8 |
| `tests/unit/osc_10.rs` / `osc_11.rs` / `osc_12.rs` | default fg/bg/cursor color | 6 |
| `tests/unit/osc_52.rs` | set/query, base64, invalid selection | 10 |
| `tests/unit/osc_104.rs` / `osc_105.rs` | palette reset | 4 |
| `tests/unit/osc_133.rs` | subcodes A/B/C/D round-trip | 8 |
| `tests/unit/alt_screen.rs` | 1049 / 1047 / 1048 enter/exit + cursor save/restore + nested + clear-on-exit-47 | 20+ |
| `tests/unit/resize.rs` | reflow (shrink, grow, mid-continuation-run, alt-buffer no-reflow, 0-row reject, 0-col reject, 10000-wrapped-row reflow) | 30+ |
| `tests/unit/charset.rs` | G0/G1 designator, SS2/SS3, DEC line-drawing, shift-out/in | 15+ |
| `tests/unit/grapheme.rs` | accumulator boundary, ZWJ, VS16, combining, degenerate | 20+ |
| `tests/unit/mode_state.rs` | `TerminalModeState::snapshot_from(&Modes)` correctness | 12 |
| `tests/unit/hyperlink.rs` | alloc/free ids, id stamping onto cells | 8 |

### 12.2 Integration / property tests

| File | Covers |
|------|--------|
| `tests/grid_invariants.rs` | proptest: any sequence of ops keeps invariants (list in §11). |
| `tests/golden_streams.rs` | Replays committed `.pty` streams against `.snapshot.json`. v1 streams: `cat_readme`, `ls_color`, `echo_red`, `vim_clean_quickstart`. (Full compat suite is EPIC-G.) |
| `tests/ordering.rs` | `sequence_no` strictly ascending; epoch bumps fence; `resize_generation` bumps on resize; mode changes ordered before cell deltas of new buffer; OSC events tail-ordered. |
| `tests/sync_update.rs` | DECSET 2026 + DCS BSU/ESU, timeout budget. |

### 12.3 Coverage target

`cargo tarpaulin -p quanta-vt --fail-under 95`. CI blocks merge under
95% line coverage.

---

## 13. Open questions

Honest list of decisions this design could not fully nail down; EPIC-B
implementation agent resolves during first week.

1. **SmallString threshold for `Grapheme`**: EPIC-A proposes 8 bytes
   inline. But `👨‍👩‍👧‍👦` is 25 UTF-8 bytes (4 people + 3 ZWJ). Spill to
   heap is ~fine for typical output (ZWJ emoji rare per MB), but if
   high-emoji workloads prove expensive, bump to 16 bytes. **Action**:
   bench with a dogfood recording.
2. **Scrollback row representation (§8.4)**: `Row::Dense | Row::Runs`
   split is proposed to meet the 22 MB budget. Conversion at scroll-out
   time adds CPU; needs benchmark. **Alternative**: keep `Dense`
   everywhere, reduce scrollback cap to 5,000. **Action**: bench first.
3. **Reflow of a 10,000-row continuation run (§10.2)**: streaming
   reflow would avoid the 4.8 MB temp allocation but complicates the
   algorithm. Deferring to v2; open question is whether the 4.8 MB spike
   is visible in perf telemetry.
4. **Charset translation at `print` vs at `write_grapheme`**: currently
   spec'd at `print` (before grapheme accumulation). This means DEC
   line-drawing cannot combine with a combining mark. Matches xterm;
   confirm via golden replay.
5. **OSC 4 query response channel**: OSC 4 `Pc ; ?` asks the terminal
   to report palette color N via an OSC response. That requires an
   output channel back into the PTY — a concern for EPIC-F, not EPIC-B.
   Here we emit `OscPassthrough { code: 4, data }` and let EPIC-F
   format the response. **Action**: confirm EPIC-F accepts this split.
6. **`grid_epoch` scope**: ADR 0017 open-Q leans "per session" over
   "per (session, buffer_kind)". This design assumes per-session
   (alt-screen is a swap, not an epoch). **Action**: finalize in
   EPIC-B implementation week 1, update ADR 0017.
7. **Unknown-CSI "shape" in telemetry**: `UnknownCsi { final_byte, intermediates, params }`
   is verbose; should we hash and counter by hash to keep telemetry
   cardinality finite? **Action**: confirm with EPIC-J.
8. **`TerminalInput` trait lives here vs its own crate**: this design
   keeps it in `quanta-vt::ports` so EPIC-E imports from one place.
   Alternative: split into `quanta-vt-input` to avoid EPIC-E pulling in
   all of `quanta-vt`. **Action**: decide after EPIC-E dependency
   scan.
9. **RIS (ESC c) full-reset semantics**: should it bump `grid_epoch`?
   A program calling RIS arguably wants the UI to resync completely.
   Leaning yes (RIS is rare; cost is one snapshot). **Action**: confirm
   by dogfood `reset` / `tput reset` behavior.
10. **Synchronized-update timeout (150 ms)**: matches iTerm2 default,
    but kitty uses 200 ms. **Action**: make configurable via
    `Grid::new` builder; default 150 ms.

---

## 14. Integration points

### 14.1 EPIC-C (Protocol + Reducer + UI mirror)

EPIC-C wraps `TerminalEvent` in `EventEnvelope<P>` per ADR 0017, serializes
via serde (MessagePack on wire), and defines `GridMirror::apply`.

Protocol (5 lines):

```
C pulls: use quanta_vt::ports::{TerminalEvent, EventEnvelope};
C wraps: for event in grid.feed(bytes) { out.push(EventEnvelope { session_id, grid_epoch: grid.epoch(), sequence_no: grid.next_sequence(), buffer_kind: grid.active_buffer(), resize_generation: grid.resize_generation(), payload: event }); }
C serializes: serde_cbor or msgpack; golden JSON committed under crates/quanta-proto/tests/fixtures/schemas/.
C consumer (UI): GridMirror::apply discards if envelope.grid_epoch < applied, else applies by sequence.
C owns: wire format freeze. EPIC-B owns the payload type freeze.
```

### 14.2 EPIC-F (Session actor + fanout)

EPIC-F holds the `Grid` inside the session actor; feeds PTY chunks;
dispatches events through fanout.

Protocol (5 lines):

```
F constructs: Grid::new(rows, cols, scrollback_cap, shared_classifier).
F drives: loop { let chunk = pty.read().await; let events = grid.feed(&chunk); for e in events { fanout.send(envelope_wrap(e)).await; } }.
F resizes: on SIGWINCH / UI resize → grid.resize(rows, cols); events emitted include Resize + GridSnapshot.
F reconnect: grid.reinit_epoch(); next feed begins with a fresh snapshot.
F persistence: events persisted via quanta-events; replay on resume feeds raw bytes back through a fresh Grid.
```

### 14.3 EPIC-E (Input encoder)

EPIC-E reads `TerminalModeState` as a snapshot per ADR 0017 §4 rule "no
live reads mid-encode".

Protocol (5 lines):

```
E obtains: let modes = grid.mode_snapshot();  // one call per key event
E encodes: let bytes = encoder.encode_key(&event, &modes);
E returns: bytes flow to PTY via session actor (EPIC-F wiring).
E MUST NOT: live-read grid or modes during encode. Snapshot is the only read.
E receives: mode changes come back as ModeChanged events through the same reducer stream; EPIC-E's ModeSnapshot is updated on apply, not on emit.
```

---

## 15. Contract freeze checklist

Once this design doc is reviewed and merged, the following are frozen
and downstream epics may code against them:

- [ ] `EventEnvelope<P>` — fields: `session_id`, `grid_epoch`,
      `sequence_no`, `buffer_kind`, `resize_generation`, `payload`.
      (§2.9)
- [ ] `TerminalEvent` variants list: `GridSnapshot`, `GridDelta`,
      `CursorMoved`, `ModeChanged`, `TitleChanged`, `CwdChanged`,
      `BellRequested`, `HyperlinkOpened`, `HyperlinkClosed`,
      `ClipboardRequest`, `OscPassthrough`, `ClearScrollback`, `Resize`,
      `SynchronizedUpdate`, `UnknownCsi`, `UnknownOsc`,
      `UnknownDecMode`. (§2.10)
- [ ] `Grid::feed(&mut self, bytes: &[u8]) -> Vec<TerminalEvent>` —
      exact signature. (§2.11)
- [ ] `Grid::resize`, `Grid::snapshot`, `Grid::row_revision`,
      `Grid::active_buffer`, `Grid::mode_snapshot`, `Grid::epoch`,
      `Grid::next_sequence`, `Grid::reinit_epoch` signatures. (§2.11)
- [ ] `TerminalModeState` snapshot shape — fields per §2.7.
- [ ] `BufferKind { Main, Alt }`. (§2.8)
- [ ] `Cell` fields: `grapheme`, `width`, `fg`, `bg`, `attrs`,
      `hyperlink`. (§2.1)
- [ ] `Color` variants: `Default`, `Palette8`, `Palette256`,
      `TrueColor`. (§2.2)
- [ ] `CursorPayload` shape. (§2.10)
- [ ] `GridSnapshot` / `GridDelta` / `RowDelta` / `CellRun` /
      `RectDamage` shapes. (§2.10)
- [ ] `ClipboardPayload { Set, Query }` shape. (§2.10)
- [ ] `SyncUpdatePayload { Begin, End, Timeout }`. (§2.10)
- [ ] `TerminalInput` trait method signatures. (§2.12)
- [ ] Flush policy: at end of `feed()`; event order §7.4.
- [ ] DEC mode v1 coverage set (§5) and non-v1 deferral list.
- [ ] OSC v1 coverage set (§6).

Downstream epics must NOT add, remove, or rename these without an RFC
amendment.

---

## 16. Definition of Done (DoD)

A testable checklist. Every item maps to a specific test file, CI job, or
code artifact in this crate. No fluffy items. Items are grouped by the
contract or audit section they derive from.

### 16.1 Public API present + documented (from §2)

- [ ] `Cell` struct exists with `grapheme`, `width`, `fg`, `bg`, `attrs`,
      `hyperlink` fields — signature matches §2.1. Rustdoc present; example
      compiled by `cargo test --doc`.
- [ ] `Color { Default, Palette8, Palette256, TrueColor { r, g, b } }` exists
      with per-variant rustdoc — §2.2.
- [ ] `CellAttrs` bitflags struct with the full attribute set (bold, italic,
      underline, reverse, strikethrough, blink, invisible, WIDE_CONTINUATION)
      — §2.1 + §2.3; test in `tests/unit/sgr.rs`.
- [ ] `Cursor`, `CursorShape`, `CursorSave` with DECSC/DECRC chain;
      unit-tested in `tests/unit/alt_screen.rs` + `tests/unit/csi_cursor.rs`.
- [ ] `SgrState` + `CellAttrs` reset semantics — `tests/unit/sgr.rs`.
- [ ] `CharsetState`, `CharsetSlot`, `CharsetTable` — `tests/unit/charset.rs`.
- [ ] `Modes` + `DecMode` enum — one test per DEC mode in §5 covered by
      `tests/unit/dec_modes.rs` (17 tests).
- [ ] `TerminalModeState` snapshot shape — `tests/unit/mode_state.rs`
      (12 tests); rustdoc explicitly states "snapshot, never live-read".
- [ ] `BufferKind { Main, Alt }`, `Rect`, `GridSnapshot`, `GridDelta`,
      `RowDelta`, `CellRun`, `RectDamage` payload types exist with signatures
      matching §2.10.
- [ ] `TerminalEvent` enum with all variants from §2.10 + freeze checklist
      §15; one test per variant under `tests/unit/events_shape.rs`.
- [ ] `EventEnvelope<P>` with `session_id`, `grid_epoch`, `sequence_no`,
      `buffer_kind`, `resize_generation`, `payload` — §2.9; tested in
      `tests/ordering.rs`.
- [ ] `TerminalInput` trait with `KeyEvent`, `MouseEvent`, `PasteEvent`,
      `FocusEvent` — §2.12; compile-check via a dummy impl in
      `tests/unit/input_trait.rs`.

### 16.2 Engine behavior (from §3 invariant audit, §5 DEC modes, §6 OSC)

- [ ] Every DEC mode listed in §5 has a unit test in `tests/unit/dec_modes.rs`;
      all 17 pass.
- [ ] Every OSC listed in §6 has a handler test
      (`tests/unit/osc_0.rs` … `osc_133.rs`); all pass.
- [ ] Scrollback ring maintains capacity invariant under fuzz — fuzz target
      `vte_process.rs` asserts `grid.scrollback_len() <= scrollback_cap`.
- [ ] Alt-screen enter/exit: 5 scenarios tested in `tests/unit/alt_screen.rs`
      — enter-exit simple, nested (vim in tmux simulation), 1047 clear-on-exit,
      1048 save/restore only, 1049 full save+switch+restore.
- [ ] Resize edge cases: 0 rows rejected (returns Err), 0 cols rejected,
      shrink during a continuation run reflows correctly, grow re-expands
      without data loss, alt-buffer resize does NOT reflow — all covered in
      `tests/unit/resize.rs`.
- [ ] `vte::Perform::print` buffers graphemes via EPIC-A `WidthClassifier` —
      integration test `tests/unit/grapheme.rs` asserts Korean `한` occupies
      2 columns, ZWJ `👨‍👩‍👧‍👦` 1 grapheme / 2 columns, combining `e + U+0301`
      1 column.
- [ ] Right-half-of-wide-char marker emitted as `CellWidth::Zero` sibling with
      `CellAttrs::WIDE_CONTINUATION` — `tests/unit/grapheme.rs`.
- [ ] Continuation flag set on wrapped rows; explicit `\n` rows not flagged —
      `tests/unit/csi_cursor.rs` or a dedicated `tests/unit/wrap.rs`.

### 16.3 Ordering + epoch semantics (from ADR 0017, §4 state machines)

- [ ] `sequence_no` is strictly ascending per `grid_epoch` — asserted by
      `tests/ordering.rs` across a recorded stream of 10k events.
- [ ] `grid_epoch` increments on `Grid::reinit_epoch()` — `tests/ordering.rs`.
- [ ] `resize_generation` increments on `Grid::resize()` — `tests/ordering.rs`.
- [ ] Alt-screen `ModeChanged` arrives before first alt-buffer cell delta —
      `tests/unit/alt_screen.rs` inspects event order.
- [ ] Event flush policy per §7.4: mode-changes first, then cursor, then cell
      deltas, then OSC tail — `tests/ordering.rs`.

### 16.4 Robustness + fuzz

- [ ] `Grid::feed` never panics — fuzz target `vte_process.rs` runs 60 min
      on CI nightly without a panic finding.
- [ ] Grid invariants hold under fuzz: row count stable, cursor in range,
      row revisions monotonic, scrollback bounded — `tests/grid_invariants.rs`
      property test + fuzz target assertions.
- [ ] No `panic!`/`unwrap` in library code (`src/**/*.rs`); grep rule in
      EPIC-K `check-no-unwrap` extended to cover this crate.

### 16.5 Reference-implementation parity

- [ ] Committed golden replay fixture `tests/compat/vim_clean_quickstart/`
      replays `vim --clean` → the resulting grid matches the Alacritty-recorded
      reference grid snapshot within ±0 cells.
- [ ] Committed `tests/compat/tmux_new_session/` replay matches reference
      within ±0 cells; title change fires.
- [ ] Committed `tests/compat/htop_snapshot/` replay matches reference; alt
      screen entered; cell grid populated.
- [ ] (Note: full compat matrix is EPIC-G; this epic carries three
      smoke-level fixtures to prove the pipeline.)

### 16.6 Lint + format + coverage

- [ ] `cargo test -p quanta-vt` green.
- [ ] `cargo clippy -p quanta-vt --all-targets -- -D warnings` clean.
- [ ] `cargo fmt --all --check` clean.
- [ ] `cargo tarpaulin -p quanta-vt --fail-under 95` green — line coverage
      ≥ 95%.
- [ ] Branch coverage ≥ 85% via `cargo llvm-cov --branch --fail-under 85`.

### 16.7 Spec + ADR artifacts

- [ ] ADR 0017 status → `Accepted` in
      `docs/adr/0017-reducer-ordering-and-mode-authority.md`.
- [ ] This design doc's §15 "Contract freeze checklist" all items ticked.
- [ ] Open questions in §13 all resolved in follow-up commits with inline
      `// Decision:` comments at the resolution site.

**DoD item count: 34 items.** Every item is a separate checkbox; each maps to
a file, a test, a CI job, or an explicit ADR state.

---

## 17. Quality Gates

Hard merge blocks for EPIC-B. Each gate names the CI job or script that
enforces it.

| Gate | Enforced by (CI job) | Failure behavior |
|---|---|---|
| Unit tests green | `cargo test -p quanta-vt` step in `.github/workflows/vt-engine.yml` | PR blocked |
| Grid invariants (proptest) green | `cargo test -p quanta-vt --test grid_invariants` | PR blocked |
| Ordering invariants green | `cargo test -p quanta-vt --test ordering` | PR blocked |
| Golden stream smoke (3 fixtures) green | `cargo test -p quanta-vt --test golden_streams` | PR blocked |
| Clippy clean | `cargo clippy -p quanta-vt --all-targets -- -D warnings` | PR blocked |
| fmt clean | `cargo fmt --all --check` | PR blocked |
| Line coverage ≥ 95% | `cargo tarpaulin -p quanta-vt --fail-under 95` | PR blocked |
| Branch coverage ≥ 85% | `cargo llvm-cov --branch --fail-under 85` | PR blocked |
| No `\x1b` parsing outside crate | EPIC-K grep rule `check-ui-no-ansi` (extended to whitelist `crates/quanta-vt/` only) | PR blocked |
| No `panic!`/`unwrap` in lib | EPIC-K grep rule `check-no-unwrap` scoped to `crates/quanta-vt/src/**` | PR blocked |
| No I/O in crate | Greps `src/**/*.rs` for `std::fs`, `std::net`, `tokio::`, `async_std::` — hit → fail | PR blocked |
| Fuzz smoke (per PR) | `.github/workflows/fuzz-smoke.yml` — 2 min run on `vte_process` target | PR blocked on panic |
| Fuzz long-run (nightly `main`) | `.github/workflows/fuzz-nightly.yml` — 60 min run | Regressions filed P0; not a PR blocker |
| EPIC-A types imported unchanged | Compile-check only — EPIC-B can only reference the `WidthClassifier` / `CellWidth` / `Grapheme` shapes frozen by EPIC-A. Any attempt to re-define them locally fails review. | PR blocked |

All gates above must be green before EPIC-B is marked exit; EPIC-C, F may
begin spec-freeze implementation once §17 gates hold and §15 freeze checklist
is ticked.

---

## 18. End-to-end scenarios

7 E2E scenarios that exercise the engine as a whole. Each reads a recorded
PTY stream, feeds it through `Grid::feed`, and asserts the resulting grid +
emitted events. Fixtures live under `tests/compat/<name>/` and follow the
golden-stream format EPIC-G will formalize; for EPIC-B exit these three-file
shapes suffice: `input.pty` (raw bytes), `expected_grid.json` (snapshot),
`expected_events.json` (ordered event trace with envelope metadata).

### E2E-B1: `vim --clean` replay → grid match

**Setup**. Fixture `tests/compat/vim_clean_quickstart/` with a recorded
`vim --clean` session: open, enter insert mode, type `hello\nworld`, `ZZ`.
Fixed `TERM=xterm-256color`, `LINES=24`, `COLUMNS=80`.

**Run**. `Grid::new(24, 80, scrollback=1000, classifier)`, then
`grid.feed(&input_bytes)` in 4KB chunks until EOF.

**Assert**.
- `grid.snapshot()` equals `expected_grid.json` (cell-for-cell, cursor, modes).
- Alt-screen enter + exit `ModeChanged` fire with correct ordering.
- Cursor post-`ZZ` lands where recorded.
- Zero `UnknownCsi` events emitted (vim uses only well-known CSI).

### E2E-B2: `tmux new-session -d \; list-sessions` → title + grid

**Setup**. Fixture `tests/compat/tmux_new_session/` with recorded bytes from a
`tmux` shell invocation. Expected: title change (OSC 2), basic output, final
cursor position.

**Run**. Feed bytes; collect events.

**Assert**.
- Exactly one `TitleChanged` event, payload = `"tmux"`.
- Grid contains the session listing text in rows 0-2.
- `ModeChanged(AltScreen, _)` is NOT emitted (tmux daemon mode stays on main).

### E2E-B3: `htop -d 1` 2-second snapshot → alt-screen populated

**Setup**. Fixture `tests/compat/htop_snapshot/` — 2s of htop output.

**Run**. Feed bytes.

**Assert**.
- `ModeChanged(AltScreen, true)` fires BEFORE first cell delta into the alt
  buffer.
- Alt-buffer grid is fully populated (top bar, CPU gauges rows 0-6, process
  list rows 7-22, footer row 23).
- `resize_generation` unchanged (no resize in this fixture).
- Row revisions on populated alt rows are ≥ 1.

### E2E-B4: Fast output (`yes | head -1000`) → bounded revisions

**Setup**. Fixture `tests/compat/yes_1000/` — 1000 lines of `y\n`.

**Run**. Feed bytes in one call.

**Assert**.
- Scrollback length = min(1000, scrollback_cap); excess trimmed.
- Row revisions per row stay ≤ 1000 (bounded by number of writes to that row).
- No panic; no `UnknownCsi`.
- `sequence_no` strictly ascending across all emitted events.

### E2E-B5: Resize mid-output → `resize_generation` increments

**Setup**. Fixture `tests/compat/resize_midrun/` — start feeding a long line,
call `grid.resize(24, 60)` mid-stream, continue feeding.

**Run**. Feed prefix, resize, feed suffix.

**Assert**.
- `resize_generation` bumps exactly once.
- Events pre-resize carry the old generation; events post-resize carry the new
  one — verified by event trace.
- Continuation-tagged rows reflow to 60 columns; non-continuation rows keep
  their break.
- Cursor lands where the recorded reference says.

### E2E-B6: Alt-screen enter during active block → ModeChanged before cells

**Setup**. Fixture `tests/compat/alt_enter_racecheck/` — a synthetic stream
that prints 5 rows, sends DECSET 1049, then prints 3 rows of alt content.

**Run**. Feed bytes.

**Assert**.
- Event ordering (exact): `[CellsChanged×5-ish] [ModeChanged(AltScreen,true)]
  [CellsChanged into alt-buffer×3-ish]`.
- The alt-buffer cell deltas are NEVER interleaved with nor preceded by the
  `ModeChanged`. Retires RFC §16 #8 at the engine level.

### E2E-B7: Scroll region CSI `r` with small area → rect damage correct

**Setup**. Fixture `tests/compat/scroll_region/` — set scroll region to rows
5-10 (CSI 6;11r), write enough lines to trigger scroll within that region.

**Run**. Feed bytes.

**Assert**.
- `RectDamage { top: 5, bottom: 10, .. }` events emitted for scroll content.
- Rows outside 5-10 have revision unchanged from pre-feed.
- Scrollback is untouched (scrolling inside a region does not go to scrollback).

---

## 19. Test coverage targets

Operational coverage requirements this epic commits to. All enforced via CI
(see §17 gates).

- **Line coverage**: ≥ 95% on `crates/quanta-vt/src/**` measured by
  `cargo llvm-cov` or `cargo tarpaulin`. Failure gates the PR (§17).
  Uncovered lines require an explicit `// coverage: justified-gap — <reason>`
  comment.

- **Branch coverage**: ≥ 85% on `crates/quanta-vt/src/**` measured by
  `cargo llvm-cov --branch`.

- **Fuzz**: nightly 60-minute run on `main` via
  `.github/workflows/fuzz-nightly.yml` against
  `fuzz/fuzz_targets/vte_process.rs`. Corpus accumulates; regressions trigger
  a P0 issue. Per-PR 2-minute smoke run via `fuzz-smoke.yml`.

- **Property tests**: `tests/grid_invariants.rs` (proptest) runs 256 cases per
  invariant (default) on every PR. Invariants listed in §11. Any counterexample
  fails the PR; CI prints the minimized case.

- **Golden streams**: 3 smoke fixtures (vim, tmux, htop) on every PR. Full
  compat suite (≥ 13 programs) is EPIC-G.

- **Ordering fault injection**: `tests/ordering.rs` includes injection cases:
  stale-epoch event, stale `resize_generation` event, mode change reordered
  to after cell delta. Each case must be correctly rejected by any future
  consumer (per ADR 0017); engine-side test confirms events are emitted in
  the correct order so consumers never see the fault cases in the happy path.

---

**End of document.**
