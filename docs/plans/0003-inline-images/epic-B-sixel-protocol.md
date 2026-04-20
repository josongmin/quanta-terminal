# EPIC-B Design — Sixel Protocol Parser

- **Status**: Design-ahead (Gear 3). Freezes the `SixelParser` VT-side state machine API, palette table shape, and RLE cap policy.
- **Date**: 2026-04-20
- **Related**: RFC 0003 §5.1 (sixel protocol reference), §7.1 (component layout), §9 (parse-politely semantics), §13.3 (reflow: sixel clips), EPIC-A (decoder adapter trait + `DecodedImage`), RFC 0001 §5 (VT engine authority), §7.4 (event envelope).
- **Blocks**: EPIC-E (which reads the RawImagePayload this parser emits).

One-paragraph read: Sixel lands in the VT engine as a dedicated DCS handler alongside existing DCS sequences. The parser is a three-state machine (`Idle → InDcsParams → InSixelBody`) that buffers bytes until the ST terminator, computes the approximate decoded dimensions from the body (for pre-commit size-cap rejection), and hands a `RawImagePayload { protocol: Sixel, params: SixelParams, bytes }` to the decoder dispatch queue. Even when `experimental.images='off'` the parser still runs — its byte-consumption and cursor-advance rules are compatibility requirements, not rendering niceties. A standalone fuzz target exercises the parser state machine (distinct from EPIC-A's decoder fuzz).

---

## 1. Summary

- **Goal**: Parse `ESC P <params> q <sixel-data> ESC \` streams inside `quanta-vt`, dispatch payload to the decoder, advance the cursor per DEC convention, and emit a `RawImagePayload` for downstream Grid integration (EPIC-E).
- **Phase**: 2 (per RFC 0003 §17).
- **Duration**: 1.5 weeks.
- **Dependencies**: EPIC-A spec-freeze (trait + types). RFC 0001 EPIC-B `Grid` cursor-advance API available.
- **Owner**: VT Engine squad.

### 1.1 Contracts frozen

- `SixelParser` public API (`feed_byte(ctx, byte)`, `finalize(ctx)`).
- `SixelParams { p1: u8, p2: u8, p3: u8 }` struct.
- Raster-attributes (`" Pan;Pad;Ph;Pv`) lookahead contract.
- Cursor-advance rule for sixel completion.
- Fuzz-target signature for state-machine-level fuzz.

### 1.2 Contracts consumed

- `quanta_image_decoder::Protocol::Sixel`, `DecoderLimits`, `DecodeError`.
- `quanta_vt::Grid::advance_cursor_after_image(rows: u16)`.
- `quanta_vt::ImageDispatchQueue::enqueue(payload)`.

---

## 2. Background

### 2.1 Sixel in one paragraph

Sixel encodes a 6-pixel-tall row as bit-packed ASCII characters (`?` = 0b000000, `~` = 0b111111). Images are a sequence of such rows separated by `-` (row advance) with `$` (carriage return) for multi-color overlay. RLE (`!<n><char>`) compresses runs. Palette definitions (`#n;2;r;g;b`) set colors before a `#n` selection reference uses them. The envelope is a DCS (`ESC P ... ESC \`).

### 2.2 What the VT engine owns vs the decoder

- **VT engine (this epic)**: DCS envelope parsing, param extraction, body framing, size-cap fast-reject on body length, cursor advance, dispatch.
- **Decoder (EPIC-A)**: body → RGBA decoding, palette resolution, RLE expansion, dim computation.

Rationale: engine must remain hot-path safe; all expensive per-byte RLE work happens off-thread.

### 2.3 Why `off` mode still runs the parser

If the engine stops at `ESC P` without consuming through `ESC \`, the remaining bytes leak into the grid as random ASCII. Cursor positions drift. Every shell that ran `chafa` would visually desync. Parse-and-discard is the compatibility floor.

---

## 3. Scope

### 3.1 Files

| File | Purpose |
|------|---------|
| `crates/quanta-vt/src/parsers/sixel.rs` | New. `SixelParser` state machine. |
| `crates/quanta-vt/src/parsers/mod.rs` | Updated. Re-export `SixelParser`. |
| `crates/quanta-vt/src/dispatch/sixel.rs` | New. Bridge from VT DCS callback to `SixelParser`. |
| `crates/quanta-vt/src/image_dispatch.rs` | New. Shared `ImageDispatchQueue` + `RawImagePayload` type (shared with C + D). |
| `crates/quanta-vt/src/grid.rs` | Updated. `advance_cursor_after_image` helper. |
| `crates/quanta-vt/tests/sixel_parse.rs` | 15+ golden PTY byte streams → params + cursor. |
| `crates/quanta-vt/tests/sixel_parse_fixtures/` | Real-world captures + hand-crafted. |
| `crates/quanta-vt/fuzz/fuzz_targets/fuzz_sixel_parser.rs` | New fuzz target — state-machine level. |
| `docs/adr/0021-image-anchor-cell-semantics.md` | Referenced, not edited here. |

### 3.2 Out of scope

- Decoded RGBA (EPIC-A).
- Grid cell placement (EPIC-E).
- Render (EPIC-F).
- Kitty / iTerm parsers (EPIC-C, EPIC-D).

---

## 4. Design

### 4.1 State machine

```rust
// crates/quanta-vt/src/parsers/sixel.rs

pub enum SixelState {
    /// Waiting for DCS ESC P.
    Idle,
    /// In DCS params (`<P1>;<P2>;<P3>`). Accumulating until `q`.
    InDcsParams { param_buf: heapless::Vec<u8, 32> },
    /// Past `q`; accumulating body bytes until ESC \.
    InSixelBody { body_buf: BytesMut, byte_budget: usize },
    /// Body exceeded budget; discard remainder, wait for terminator.
    BodyOverflow,
    /// Seen ESC; awaiting \.
    AwaitingSt { prev: Box<SixelState> },
    /// Terminated cleanly.
    Terminated,
}

pub struct SixelParser {
    state: SixelState,
    params: SixelParams,
    limits: DecoderLimits,
}

impl SixelParser {
    pub fn new(limits: DecoderLimits) -> Self { /* ... */ }

    /// Feed one byte. Returns Ok(Poll::Pending) to continue feeding,
    /// Ok(Poll::Ready(payload)) when terminator seen.
    pub fn feed_byte(&mut self, b: u8) -> Result<FeedOutcome, SixelParseError>;
}

pub enum FeedOutcome {
    Pending,
    Ready(RawImagePayload),
    Overflow,  // Body exceeded wire cap; caller emits placeholder.
}
```

### 4.2 Params parsing

`InDcsParams`:
- Accept `[0-9];` into `param_buf`.
- On `q` → transition to `InSixelBody`, parse the accumulated buffer into `SixelParams { p1, p2, p3 }` (missing params default to 0).
- On `ESC` → transition to `AwaitingSt { prev: ... }`.
- Any other byte → `SixelParseError::MalformedParams`.

### 4.3 Body accumulation

`InSixelBody`:
- Every byte except `ESC` appended to `body_buf`.
- If `body_buf.len() > byte_budget` → transition to `BodyOverflow`.
- On `ESC` → `AwaitingSt`.

### 4.4 Overflow handling

`BodyOverflow`:
- Consume bytes silently (parse-politely invariant).
- Advance cursor by a conservative `1 row` at terminator.
- Emit `FeedOutcome::Overflow` so dispatch knows to send a placeholder.

### 4.5 Terminator

`AwaitingSt`:
- If next byte is `\` (0x5C) → finalize: produce `RawImagePayload` (or `Overflow`) per prior state.
- If next byte is any other → treat the `ESC` as a body byte; return to `prev`. (Rarely triggered in real sixel, but required for resilience.)

Non-standard `BEL` terminator: telemetry-counted; accepted for compatibility.

### 4.6 Dispatch bridge

```rust
// crates/quanta-vt/src/dispatch/sixel.rs

impl vte::Perform for VteProcessor {
    fn hook(&mut self, params: &Params, intermediates: &[u8], ignore: bool, c: char) {
        if c == 'q' && intermediates.is_empty() {
            self.sixel_parser = Some(SixelParser::new(self.decoder_limits));
            // Seed params from the vte-provided params.
            self.sixel_parser.as_mut().unwrap().seed_params(params);
        }
    }

    fn put(&mut self, b: u8) {
        if let Some(parser) = &mut self.sixel_parser {
            match parser.feed_byte(b) {
                Ok(FeedOutcome::Pending) => {}
                Ok(FeedOutcome::Ready(payload)) => {
                    self.image_queue.enqueue(payload);
                    self.grid.advance_cursor_after_image(
                        height_cells_estimate(payload.hints.height_px_hint),
                    );
                    self.sixel_parser = None;
                }
                Ok(FeedOutcome::Overflow) => {
                    self.emit_placeholder(Protocol::Sixel);
                    self.sixel_parser = None;
                }
                Err(e) => {
                    hooks::count_parse_error(Protocol::Sixel, &e);
                    self.sixel_parser = None;
                }
            }
        }
    }

    fn unhook(&mut self) {
        // DCS ended without explicit terminator (session restart etc.)
        if let Some(parser) = self.sixel_parser.take() {
            parser.abort(); // no event; just cleanup.
        }
    }
}
```

### 4.7 Cursor advance

Per DEC VT340 convention:
- After sixel render, cursor moves to the beginning of the row *below* the image.
- Image height in cells is computed from `(accumulated_rows * 6 + cell_height_px - 1) / cell_height_px`.
- Since the parser doesn't decode, we use the body-byte-count as a rough height estimate: emit a placeholder advance (`1 row`) in `off` mode; EPIC-E corrects to the precise value once decode completes and the anchor cell lands.

### 4.8 Flag interaction

- `off` — parser consumes bytes, enqueues `RawImagePayload` marked `drop=true`; dispatcher drops before enqueue, only cursor advance survives.
- `stripped-placeholder` — parser enqueues real payload but with `decode_mode=PlaceholderOnly`; decoder returns a placeholder RGBA.
- `full` — parser enqueues real payload; decoder runs full path.

---

## 5. Definition of Done

1. `SixelParser` struct exported from `quanta-vt::parsers::sixel`.
2. State machine covers `Idle → InDcsParams → InSixelBody → AwaitingSt → Terminated` + `BodyOverflow` + ESC-in-body resilience.
3. Param parser handles `P1;P2;P3` and any subset.
4. Body buffer honors `DecoderLimits::wire_bytes_max`.
5. Overflow state discards bytes without allocation growth.
6. Terminator on `ESC \` emits `FeedOutcome::Ready`.
7. Non-standard `BEL` terminator accepted with telemetry counter.
8. ESC inside body (non-terminator) correctly returns to body state.
9. `unhook` / session end without ST cleanly aborts the parser.
10. 15+ golden PTY byte streams decode with correct param extraction + body length.
11. Cursor advance helper invoked exactly once per sixel completion.
12. `image_dispatch::RawImagePayload` correctly populated with `Protocol::Sixel` + params + body.
13. Flag `experimental.images='off'` drops the payload, preserves cursor advance.
14. Flag `stripped-placeholder` emits payload with `decode_mode=PlaceholderOnly`.
15. Flag `full` emits payload with `decode_mode=Full`.
16. Fuzz target `fuzz_sixel_parser` runs 24 h CI with zero panics.
17. Parser never allocates > 64 MB (body budget cap enforced).
18. No `unwrap`/`expect` in `parsers/sixel.rs` (CI grep enforces).
19. Telemetry counters for parse errors, BEL-terminators, overflow emitted.
20. ADR 0021 referenced in module docstring.

---

## 6. Quality Gates

- **Gate-1 — Cursor parity.** For every golden fixture, post-sixel cursor row/col matches a reference terminal (xterm-sixel / WezTerm) within ±1 row.
- **Gate-2 — Byte-exact body extraction.** Golden body bytes equal the bytes fed between `q` and `ESC \`.
- **Gate-3 — Fuzz panic-free.** 24 h fuzz run zero panics.
- **Gate-4 — `off`-mode cursor correctness.** Even with decoding disabled, cursor advances correctly.
- **Gate-5 — Telemetry coverage.** Every error path emits a counter.

---

## 7. E2E tests (≥ 5)

1. **E2E-B1 — `chafa image.png` cursor.** Known image input produces expected cursor row after decode (±1 row tolerance).
2. **E2E-B2 — `img2sixel` roundtrip.** PTY capture from `img2sixel` parses cleanly; body hashed against golden; cursor advances to expected row.
3. **E2E-B3 — Truncated stream.** Feed half a sixel body then close the PTY; parser aborts cleanly; engine unchanged.
4. **E2E-B4 — Oversized sixel.** 100 MB synthetic sixel stream hits wire cap; parser drops body; placeholder cell emitted by downstream (EPIC-E); grid intact.
5. **E2E-B5 — BEL-terminated sixel.** Non-standard BEL terminator accepted; telemetry counter incremented; event emitted equivalently to ST-terminated.
6. **E2E-B6 — Sixel inside `tmux` without passthrough.** tmux strips the DCS; engine sees no sixel; no crash, telemetry counter notes nothing (correct).
7. **E2E-B7 — Sixel inside `less`.** sixel emitted in alt-buffer; image anchored to alt; exit less → image gone.

---

## 8. Tests

### 8.1 Unit tests

- Param parsing: `""`, `"0"`, `"0;1"`, `"0;1;2"`, `"abc"` (err), long-run of digits (clamp).
- Body state transitions: each entry/exit path.
- ESC-in-body resilience: `"ESC X"` inside body, where X != `\`, returns to body.
- Overflow boundary: exactly `wire_bytes_max` bytes accepted; `+1` flips to overflow.
- BEL terminator: acceptance + counter.
- Unhook mid-body: no panic.

### 8.2 Integration tests

- 15+ golden PTY streams in `tests/sixel_parse_fixtures/`.
- Cross-check cursor position against reference table.

### 8.3 Fuzz tests

- `fuzz_sixel_parser.rs`:
  - Invariants: no panic, body buffer ≤ wire_bytes_max, termination in < 100 ms for 1 MB input.
  - Corpus seeded with real-world + hand-crafted pathological inputs.

---

## 9. Failure modes

- **F-B1 — DCS never terminates.** Defense: timeout at PTY-level (owned by session layer, not us); parser unaffected.
- **F-B2 — Params overflow the 32-byte heapless Vec.** Defense: clamp to 32; extra digits ignored; telemetry counter.
- **F-B3 — Body contains `0x00` bytes.** Defense: accepted; body is opaque to parser.
- **F-B4 — Multiple sixel payloads back-to-back.** Defense: `Terminated` state resets cleanly on next DCS.
- **F-B5 — Nested DCS (illegal).** Defense: outer parser wins; inner `ESC P` becomes body byte and corrupts decode; decoder returns error; placeholder shown.
- **F-B6 — Race between `hook` and `put`.** Defense: state machine is per-VT-engine-instance (single-threaded by RFC 0001 design).
- **F-B7 — Session restart mid-parse.** Defense: `unhook` aborts cleanly.
- **F-B8 — UTF-8 continuation byte inside body.** Defense: body is ASCII-sixel; non-ASCII bytes trigger `DecodeErrorKind::MalformedSixelParams` downstream.
- **F-B9 — Huge param buffer (attack).** Defense: 32-byte clamp with telemetry counter.
- **F-B10 — ESC ESC sequence in body.** Defense: first ESC enters `AwaitingSt`; second ESC returns to body (not terminator); resilient.

---

## 10. Risks

- **R-B1 — Cursor advance estimate wrong in `off` mode.** Mitigation: conservative 1-row advance; documented behavior; telemetry counter for users who see misalignment.
- **R-B2 — Real-world sixel emitters use non-standard quirks.** Mitigation: golden corpus grown from real captures; quirks documented as they surface; telemetry counter captures unknown sequences.
- **R-B3 — tmux passthrough integration.** Mitigation: documented as v1.1; v1 ships with "detected tmux without `allow-passthrough`" banner.

---

## 11. Rollback

- Feature flag `experimental.images='off'` still runs this parser (it's the compatibility layer).
- To fully disable: cfg-gate the sixel parser registration in `VteProcessor::hook`; this is a single-point rollback.
- Fuzz corpus and golden fixtures remain for re-enable.

---

## 12. Cross-refs

- RFC 0003 §5.1 — sixel protocol reference.
- RFC 0003 §7.1 — component layout.
- RFC 0003 §9 — flag semantics.
- RFC 0003 §13.1-13.3 — alt-screen + reflow.
- EPIC-A §4.6 — sixel decoder adapter consumes this parser's output.
- EPIC-E — grid integration places anchor cell based on this parser's cursor advance.
- RFC 0001 §5 — VT engine authority (invariant I-1).
- RFC 0001 §7.4 — event envelope (inherited by RawImagePayload).

---

## 13. Day-by-day

### Week 1

- **Mon** — Scaffold `parsers/sixel.rs` + `dispatch/sixel.rs` + `image_dispatch.rs`. State enum + struct + constructor. Unit test: param parse happy-path.
- **Tue** — Body-state transitions + ESC-in-body resilience + overflow path. Unit tests: 10 state transitions.
- **Wed** — `VteProcessor` integration via `hook`/`put`/`unhook`. 3 golden fixtures parse cleanly.
- **Thu** — Cursor advance wiring + `advance_cursor_after_image` helper on `Grid`. All 3 modes (`off`/`stripped-placeholder`/`full`) honored. 10 golden fixtures.
- **Fri** — Remaining 5 golden fixtures. Fuzz target scaffold. 10-min PR fuzz green.

### Week 1.5

- **Mon** — Nightly 24-h fuzz kick-off. Telemetry counter wiring. Parity test: cursor positions match reference terminal on 15 fixtures.
- **Tue** — Docs, CI grep rules, merge to main. EPIC-E (Grid integration) unblocked.

---

End of EPIC-B design.
