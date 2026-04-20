# EPIC-C Design — iTerm Inline Images Parser

- **Status**: Design-ahead (Gear 3). Freezes the OSC 1337 `File=` key-value decoder, the base64 streaming contract, and the cursor-advance rule for iTerm inline images.
- **Date**: 2026-04-20
- **Related**: RFC 0003 §5.2 (iTerm protocol reference), §7.1 (component layout), §9 (parse-politely semantics), §10 (security — base64 DoS), §13.4 (cursor advance policy), EPIC-A (decoder adapter), RFC 0001 §5 (VT engine authority), §7.4 (event envelope), OSC dispatch in `quanta-vt`.
- **Blocks**: EPIC-E (grid integration consumes the emitted payload).

One-paragraph read: iTerm inline images piggyback on the OSC dispatch the VT engine already owns. The new piece is an `ItermInlineImageParser` that extracts `File=` key-value arguments, streams the base64 payload through a bounded decoder, and produces a `RawImagePayload { protocol: Iterm, params: ItermParams, bytes }`. Parsing is mandatory across all three feature-flag states (`off`/`stripped-placeholder`/`full`) because ignoring a half-parsed `OSC 1337 File=` leaks base64 text to the grid. Base64 is the primary DoS vector for this protocol; the streaming decoder must never buffer more than `wire_bytes_max` bytes regardless of inbound rate.

---

## 1. Summary

- **Goal**: Parse `ESC ] 1337 ; File=<key=value;>* : <base64> BEL|ST` inside `quanta-vt`, extract keys + stream-decode base64, dispatch to the decoder, advance the cursor per protocol, and emit a `RawImagePayload`.
- **Phase**: 2 (per RFC 0003 §17).
- **Duration**: 1 week.
- **Dependencies**: EPIC-A spec-freeze. RFC 0001 EPIC-B OSC dispatch table accepting new OSC numbers. `base64` crate pinned in workspace.
- **Owner**: VT Engine squad (parallel with EPIC-B and EPIC-D).

### 1.1 Contracts frozen

- `ItermInlineImageParser` public API.
- `ItermParams` struct with documented defaults.
- Key-value decoder — whitespace-tolerant, duplicate-key policy (last-wins), base64-of-name decoding.
- Base64 streaming contract — size-capped, non-URL-safe + URL-safe alphabet acceptance.
- Terminator handling (`BEL` and `ST`).
- Cursor-advance rule for `doNotMoveCursor`.

### 1.2 Contracts consumed

- `quanta_image_decoder::Protocol::Iterm`, `DecoderLimits`, `DecodeError`.
- `quanta_vt::Grid::advance_cursor_after_image`.
- `quanta_vt::ImageDispatchQueue`.

---

## 2. Background

### 2.1 iTerm inline image format recap

```
ESC ] 1337 ; File = [key=value; ...] : <base64> BEL
                                              or ST (ESC \)
```

Keys (all optional except payload):
- `name` — base64-encoded filename (decorative).
- `size` — decimal bytes (hint).
- `width`, `height` — `N`, `Npx`, `Nch`, `N%`, `auto`. Defaults `auto`.
- `preserveAspectRatio` — `0` or `1`. Default `1`.
- `inline` — `0` (download) or `1` (render). Default `1`.
- `doNotMoveCursor` — `0` or `1`. Default `0`.

### 2.2 Why OSC 1337 is a good citizen

Because it lives inside the OSC dispatch the engine already has (for OSC 0 title, OSC 7 cwd, OSC 8 hyperlinks, OSC 52 clipboard), we only need a new OSC-number handler — no new DCS/APC infrastructure. The cost is the base64 payload, which is potentially large and must be streamed.

### 2.3 Why base64 streaming matters

A 256 MB PNG becomes a ~341 MB base64 OSC payload. The OSC dispatcher currently buffers the OSC string in memory. For image support we either (a) raise the OSC buffer cap, or (b) intercept OSC 1337 before the buffer fills. We pick (b) — intercept at the start of the OSC and stream through our own bounded decoder — which also applies the wire-cap at parse time.

---

## 3. Scope

### 3.1 Files

| File | Purpose |
|------|---------|
| `crates/quanta-vt/src/parsers/iterm_inline.rs` | New. `ItermInlineImageParser`. |
| `crates/quanta-vt/src/dispatch/iterm.rs` | New. OSC 1337 interception + streaming hook. |
| `crates/quanta-vt/src/osc_routing.rs` | Updated. Register `1337` handler. |
| `crates/quanta-vt/src/image_dispatch.rs` | Updated (shared file from EPIC-B). Add `ItermParams`. |
| `crates/quanta-vt/tests/iterm_parse.rs` | 15+ golden OSC 1337 captures. |
| `crates/quanta-vt/tests/iterm_parse_fixtures/` | Real captures from `imgcat` + hand-crafted. |
| `crates/quanta-vt/fuzz/fuzz_targets/fuzz_iterm_parser.rs` | State-machine fuzz. |

### 3.2 Out of scope

- Image decoding (EPIC-A).
- Grid placement (EPIC-E).
- Render (EPIC-F).
- Sixel / kitty parsers.
- OSC 1337 non-File extensions (SetMark, StealFocus etc.) — handled by existing dispatch.

---

## 4. Design

### 4.1 State machine

```rust
// crates/quanta-vt/src/parsers/iterm_inline.rs

pub enum ItermState {
    /// Awaiting "File=" literal after the "1337;" entry.
    AwaitingFileLiteral,
    /// Accumulating key=value pairs up to ':' separator.
    InKeyValues { kv_buf: BytesMut },
    /// Streaming base64 payload up to BEL/ST.
    InBase64Payload { decoder: base64::read::DecoderReader<'static>, bytes: BytesMut, budget: usize },
    /// Payload budget exceeded — discard tail until terminator.
    PayloadOverflow,
    Terminated,
}

pub struct ItermInlineImageParser {
    state: ItermState,
    params: ItermParams,
    limits: DecoderLimits,
}
```

### 4.2 `ItermParams`

```rust
#[derive(Clone, Debug, Default)]
pub struct ItermParams {
    pub name: Option<String>,         // base64-decoded, valid UTF-8 or None.
    pub size_hint: Option<u64>,
    pub width: DimSpec,
    pub height: DimSpec,
    pub preserve_aspect_ratio: bool,  // default true.
    pub inline: bool,                 // default true.
    pub do_not_move_cursor: bool,     // default false.
}

#[derive(Clone, Copy, Debug)]
pub enum DimSpec {
    Auto,
    Pixels(u32),
    Cells(u16),
    Percent(u8),
}

impl Default for DimSpec {
    fn default() -> Self { DimSpec::Auto }
}
```

### 4.3 Key-value decoder

- Splits on `;`.
- Each entry `key=value`; missing `=` → entry ignored with telemetry counter.
- Unknown keys → ignored with telemetry counter.
- Duplicate keys → last-wins (documented).
- `name` base64-decoded using URL-safe alphabet first, then standard, fallback `None` on failure.

### 4.4 Base64 streaming

- Use `base64::read::DecoderReader` wrapping the payload byte stream.
- Output cap: `limits.wire_bytes_max` bytes.
- Whitespace tolerant (spaces + CRLF inside base64 stripped before decode).
- Unpadded allowed.
- Invalid chars → telemetry counter + `DecodeErrorKind::MalformedBase64` (decoder rejects).

### 4.5 Terminator handling

Both `BEL` (0x07) and `ST` (`ESC \`) terminate. OSC dispatcher already calls into parser on each terminator variant; parser treats them identically.

### 4.6 Cursor advance

- Per protocol: after image render, cursor moves to row below image unless `do_not_move_cursor=true`.
- Height in cells estimated from `DimSpec::Cells(h)` if set; else from `height_px` hint (post-decode); else 1 row default in `off` mode.
- `doNotMoveCursor=true` → cursor unchanged.

### 4.7 Dispatch integration

```rust
// crates/quanta-vt/src/dispatch/iterm.rs

impl VteProcessor {
    fn dispatch_osc_1337(&mut self, body: &[u8]) {
        // body is everything between "1337;" and the terminator.
        // Fast path: body doesn't start with "File=" → treat as generic OSC 1337 (not our concern).
        if !body.starts_with(b"File=") {
            self.legacy_osc_1337(body);
            return;
        }

        let mut parser = ItermInlineImageParser::new(self.decoder_limits);
        match parser.feed_body(&body[b"File=".len()..]) {
            Ok(FeedOutcome::Ready(payload)) => {
                let advance_rows = if parser.params.do_not_move_cursor { 0 } else { 1 };
                self.image_queue.enqueue(payload);
                self.grid.advance_cursor_after_image(advance_rows);
            }
            Ok(FeedOutcome::Overflow) => {
                self.emit_placeholder(Protocol::Iterm);
            }
            Err(e) => {
                hooks::count_parse_error(Protocol::Iterm, &e);
            }
        }
    }
}
```

Notes:
- OSC dispatcher (existing) already buffers the OSC body; we adapt to that by passing the whole body through `feed_body`. That preserves the existing dispatcher architecture but adds a cap.
- The dispatcher's *own* OSC-body cap is bumped to `wire_bytes_max` for OSC 1337 specifically (via a per-OSC-number cap override). All other OSCs keep their existing tight caps.

### 4.8 Flag interaction

- `off` — payload built + discarded; cursor advance preserved.
- `stripped-placeholder` — payload emitted with `decode_mode=PlaceholderOnly`.
- `full` — payload emitted with `decode_mode=Full`.

---

## 5. Definition of Done

1. `ItermInlineImageParser` exported from `quanta-vt::parsers::iterm_inline`.
2. OSC 1337 `File=` intercepted; other OSC 1337 variants pass through to legacy handler.
3. Key-value decoder covers: `name`, `size`, `width`, `height`, `preserveAspectRatio`, `inline`, `doNotMoveCursor`.
4. `DimSpec` supports `auto`, `Npx`, `Nch`, `N%`, plain `N` (pixels).
5. Base64 decoder streams; never buffers more than `wire_bytes_max`.
6. URL-safe + standard alphabets both accepted; padding optional.
7. Whitespace inside base64 tolerated.
8. BEL + ST both terminate cleanly.
9. `doNotMoveCursor=true` honored — cursor unchanged.
10. `inline=0` → image dropped (not rendered, not placeholder'd).
11. Duplicate keys — last-wins.
12. Unknown keys — ignored with telemetry counter.
13. `name` base64-decoded best-effort; invalid → `None`.
14. Payload-overflow path drops tail + emits placeholder.
15. 15+ golden fixtures parse correctly — params + body + cursor.
16. Fuzz target `fuzz_iterm_parser` runs 24 h CI panic-free.
17. No `unwrap`/`expect` in parser code.
18. All three flag modes exercised in tests.
19. Telemetry counters for: parse errors, unknown keys, base64 errors, overflow, BEL-vs-ST terminator, `inline=0` drops.
20. Cross-platform — tests green on macOS + Linux + Windows runners.

---

## 6. Quality Gates

- **Gate-1 — `imgcat` parity.** Captures from `imgcat` on macOS parse with 100% key-recovery.
- **Gate-2 — Base64 streaming.** 100 MB base64 payload with `wire_bytes_max=64MB` stops decode at 64 MB, no process memory growth beyond 80 MB.
- **Gate-3 — Fuzz panic-free.** 24 h fuzz zero panics.
- **Gate-4 — Cursor-advance parity.** Cursor matches iTerm2 reference behavior on 15 fixtures.
- **Gate-5 — `inline=0` honored.** Download-mode images never produce a placeholder cell.

---

## 7. E2E tests (≥ 5)

1. **E2E-C1 — `imgcat image.png`.** Capture → parser → decoded image bytes match the original PNG byte-exact.
2. **E2E-C2 — `imgcat -W 40 image.png` (width in cells).** `DimSpec::Cells(40)` correctly extracted; anchor cell span = 40 cols.
3. **E2E-C3 — `doNotMoveCursor=1`.** Cursor position unchanged after image.
4. **E2E-C4 — Oversized base64 payload.** 256 MB base64 stream terminates parse at 64 MB cap; placeholder emitted; grid intact.
5. **E2E-C5 — Non-base64 noise in payload.** Random bytes injected inside base64 → parse returns MalformedBase64; placeholder emitted.
6. **E2E-C6 — BEL terminator.** `ESC ] 1337 ; File = ... : <b64> BEL` (no ST) parses cleanly.
7. **E2E-C7 — `inline=0` pure-download mode.** No cell emitted; cursor unchanged; telemetry counter `image.iterm.inline_0_drop` incremented.

---

## 8. Tests

### 8.1 Unit tests

- `DimSpec` parse: each of `N`, `Npx`, `Nch`, `N%`, `auto`, `""` (default).
- Key-value split — 20 permutations (padding, spaces, duplicates, missing `=`).
- `name` base64-decode — URL-safe + standard + invalid.
- Base64 streaming — partial input, padded, unpadded, URL-safe, whitespace-injected.
- Terminator BEL vs ST — identical outcome.
- Cursor-advance: `do_not_move_cursor=true` → 0; else → (height hint or 1).

### 8.2 Integration

- 15+ golden fixtures in `tests/iterm_parse_fixtures/`.
- Cross-flag test matrix (`off`/`stripped-placeholder`/`full`) × 5 fixtures.

### 8.3 Fuzz

- `fuzz_iterm_parser.rs`:
  - Invariants: no panic, buffer ≤ `wire_bytes_max`, terminates in < 100 ms for 1 MB input.
  - Corpus: real `imgcat` captures + pathological (16 MB random bytes, truncated mid-b64, nested OSC).

---

## 9. Failure modes

- **F-C1 — `File=` not present (other OSC 1337 ext).** Defense: pass-through to legacy handler.
- **F-C2 — Empty body after `File=`.** Defense: emit error; no payload; cursor unchanged.
- **F-C3 — Key with no `=`.** Defense: skip + counter.
- **F-C4 — Unknown key.** Defense: skip + counter.
- **F-C5 — `size=999999999999999999`.** Defense: `size` is decorative; overflow → `None`.
- **F-C6 — `width=auto;width=10`.** Defense: last-wins → `Pixels(10)`.
- **F-C7 — base64 with `=` padding in the middle (invalid).** Defense: streaming decoder emits error; placeholder.
- **F-C8 — Giant `name` field.** Defense: base64-decoded name capped at 1024 bytes; overflow → `None`.
- **F-C9 — Concurrent OSC 1337 images.** Defense: OSC dispatch is serial (RFC 0001); multiple images arrive sequentially.
- **F-C10 — `inline=1` + `width=0%`.** Defense: 0% → `Auto`; 0px → `Auto`; telemetry counter for weird dims.
- **F-C11 — OSC buffer growth from giant base64.** Defense: per-OSC-number cap override for 1337 = `wire_bytes_max`.
- **F-C12 — Binary data in payload (not base64).** Defense: decoder emits `MalformedBase64`.
- **F-C13 — CRLF line-breaks in base64.** Defense: accepted — standard relaxation.
- **F-C14 — Missing `:` separator.** Defense: treat entire body as key-values, no payload → error → placeholder.
- **F-C15 — `doNotMoveCursor=abc` (non-bool).** Defense: parse fails → default `false` + counter.

---

## 10. Risks

- **R-C1 — `imgcat` protocol drift.** Mitigation: golden corpus pinned to iTerm2 3.5; re-sync each release.
- **R-C2 — Base64 streaming lib panics on adversarial input.** Mitigation: EPIC-A's panic-catcher upstream; also local try-catch.
- **R-C3 — OSC buffer cap override bleeds into other OSCs.** Mitigation: cap override is keyed by OSC number; strict test coverage.

---

## 11. Rollback

- Remove the `1337` handler from `osc_routing.rs` registration — OSC falls through to default handler which discards.
- Cursor advances 0 rows (default). `imgcat` visibly broken on rollback, but engine stable.

---

## 12. Cross-refs

- RFC 0003 §5.2 — iTerm protocol reference.
- RFC 0003 §10 — security (base64 DoS).
- EPIC-A §4.7 — iTerm decoder adapter.
- EPIC-B §4.6 — shared `image_dispatch` module.
- EPIC-E — places anchor cell from this parser's output.
- RFC 0001 §7.4 — event envelope.

---

## 13. Day-by-day

### Week 1 (1 week total)

- **Mon** — Scaffold parser + state enum + `ItermParams`. Key-value decoder unit tests.
- **Tue** — Base64 streaming integration + cap enforcement. `DimSpec` parser.
- **Wed** — OSC 1337 routing interception; legacy pass-through wired. 5 golden fixtures parse.
- **Thu** — Cursor-advance + flag modes + remaining 10 golden fixtures.
- **Fri** — Fuzz target + 10-min PR fuzz + telemetry. Nightly 24-h fuzz kicked off. Merge Monday after soak.

---

End of EPIC-C design.
