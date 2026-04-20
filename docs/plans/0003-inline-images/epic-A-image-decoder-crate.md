# EPIC-A Design — Image Decoder Crate (`quanta-image-decoder`)

- **Status**: Design-ahead (Gear 3). Freezes the `ImageDecoderAdapter` trait + `DecodedImage` / `DecodeError` types used by every downstream protocol-parser epic.
- **Date**: 2026-04-20
- **Related**: RFC 0003 §7.2 (crate charter), §10 (security), §11 (storage), §12 (performance), §16 (telemetry), RFC 0001 §12 (renderer contract — unaffected here), ADR 0019 / 0020 / 0021 (spawn of RFC 0003).
- **Blocks**: EPIC-B (sixel), EPIC-C (iTerm), EPIC-D (kitty) — all call into this crate.

One-paragraph read: `quanta-image-decoder` is the single place where raw protocol bytes become decoded RGBA. Three adapters — sixel, iTerm, kitty — each implement a shared `ImageDecoderAdapter` trait that returns a `DecodedImage` or a `DecodeError`. The crate is fuzz-hardened (panic-free, memory-bounded) before any parser epic wires it in. No network, no syscalls beyond temp-file reads for allowlisted paths, no unsafe code outside documented hot paths, no unwrap/expect in library code. Size caps (RFC 0003 §10.4) are enforced at the crate boundary, not at the call-site.

---

## 1. Summary

- **Goal**: Ship the `quanta-image-decoder` crate with three protocol adapters, shared types, panic-catching wrapper, size-cap enforcement, and a fuzz corpus that proves panic-free + memory-bounded invariants.
- **Phase**: 1 (per RFC 0003 §17).
- **Duration**: 2 weeks.
- **Dependencies**: ADR 0020 (decoder sandbox contract) accepted. Workspace pulls in `image = "0.24"` and `base64 = "0.21"` (versions pinned).
- **Owner**: Platform / Core squad. Security review signed by Platform Lead.

### 1.1 Contracts frozen here

- `ImageDecoderAdapter` trait — common entry point for every protocol.
- `DecodedImage` struct — canonical output shape for a successfully-decoded image.
- `DecodeError` enum + `DecodeErrorKind` — exhaustive failure taxonomy.
- Size-cap API (`DecoderLimits`) — configurable caps honored by every adapter.
- Content-hash convention (xxh3-128 over the decoded RGBA bytes).
- Panic-catcher wrapper function — all adapters run inside it.

### 1.2 Contracts consumed

- `quanta-proto::Protocol` enum (sixel / iterm / kitty) — source of the tag that routes bytes to the right adapter.
- `quanta-metrics` counter registry — for telemetry hooks (§10 here).

---

## 2. Background

### 2.1 Why a dedicated crate

RFC 0003 §24.1 covers the editorial. The operational rationale: `image` crate pulls in several transitive deps with historical CVE exposure. Isolating those deps to a standalone crate lets us (a) pin versions independently, (b) feature-gate image support so downstream consumers can opt out, (c) run fuzz targeting only the decoder, and (d) keep `quanta-vt` compile time tight.

### 2.2 What decodes where

- **Sixel** — pure-Rust state machine; no `image` crate needed. Palette + RLE + 6-pixel row accumulator → RGBA directly.
- **iTerm** — base64 decode → `image` crate dispatch by MIME sniff → RGBA.
- **kitty** — RGBA/RGB direct path (no decode, just copy + validate) OR `image` crate for PNG.

### 2.3 Why panic-catcher, not Result-everywhere

The `image` crate has internal `panic!` sites (assertions in corner-case paths — documented upstream as "should never happen on valid input"). We cannot audit every one. A `catch_unwind` boundary turns a panic into a `DecodeError::Panicked` with a telemetry counter, which is the right behavior — a hostile stream must not crash the engine.

### 2.4 Why size caps at the crate boundary

Every adapter can hit size explosions differently (sixel RLE, iTerm base64 payload, kitty chunked transmit). Centralizing the caps in the crate entry point means each adapter gets budget checked uniformly; adapters themselves only enforce *their* protocol's internal caps (e.g., sixel palette size).

---

## 3. Scope

### 3.1 Files

All new. Tests live in `tests/`; fuzz targets in `fuzz/fuzz_targets/`.

| File | Purpose |
|------|---------|
| `crates/quanta-image-decoder/Cargo.toml` | Crate manifest. Pins `image`, `base64`, `xxhash-rust`, `thiserror`. `[features]: full-decode = ["image"]` so consumers that only want placeholder can compile without the image crate. |
| `crates/quanta-image-decoder/src/lib.rs` | Public API barrel. Re-exports `ImageDecoderAdapter`, `DecodedImage`, `DecodeError`, `DecoderLimits`, `decode`. |
| `crates/quanta-image-decoder/src/types.rs` | `DecodedImage`, `Mime`, `Protocol`, `ImageHints`. |
| `crates/quanta-image-decoder/src/error.rs` | `DecodeError` + `DecodeErrorKind`. |
| `crates/quanta-image-decoder/src/limits.rs` | `DecoderLimits` struct + default builder. |
| `crates/quanta-image-decoder/src/adapter.rs` | `ImageDecoderAdapter` trait. |
| `crates/quanta-image-decoder/src/dispatch.rs` | Top-level `decode()` entry: size-cap check, panic catcher, protocol dispatch. |
| `crates/quanta-image-decoder/src/sixel.rs` | Sixel adapter (state machine, palette, RLE). |
| `crates/quanta-image-decoder/src/iterm.rs` | iTerm adapter (base64 decode + `image` crate dispatch). |
| `crates/quanta-image-decoder/src/kitty.rs` | kitty adapter (RGBA/RGB raw path + PNG via `image`). |
| `crates/quanta-image-decoder/src/hash.rs` | `xxh3_128` content-hash helper. |
| `crates/quanta-image-decoder/src/hooks.rs` | Telemetry counter hooks (calls `quanta-metrics`). |
| `crates/quanta-image-decoder/tests/sixel_decode.rs` | 20+ golden-file sixel decode cases. |
| `crates/quanta-image-decoder/tests/iterm_decode.rs` | 15+ golden-file iTerm decode cases. |
| `crates/quanta-image-decoder/tests/kitty_decode.rs` | 15+ golden-file kitty decode cases. |
| `crates/quanta-image-decoder/tests/size_cap.rs` | Size-cap boundary tests (at cap, cap-1, cap+1). |
| `crates/quanta-image-decoder/tests/panic_catch.rs` | Injected-panic test using a malformed JPEG that's known to panic upstream. |
| `crates/quanta-image-decoder/tests/hash_stability.rs` | xxh3-128 stability across OS/arch. |
| `crates/quanta-image-decoder/tests/fixtures/` | Golden PNG/JPEG/sixel/kitty inputs + expected RGBA outputs. |
| `crates/quanta-image-decoder/fuzz/Cargo.toml` | Fuzz crate manifest. |
| `crates/quanta-image-decoder/fuzz/fuzz_targets/fuzz_sixel.rs` | Sixel fuzz. |
| `crates/quanta-image-decoder/fuzz/fuzz_targets/fuzz_iterm.rs` | iTerm fuzz. |
| `crates/quanta-image-decoder/fuzz/fuzz_targets/fuzz_kitty.rs` | kitty fuzz. |
| `crates/quanta-image-decoder/fuzz/fuzz_targets/fuzz_dispatch.rs` | Top-level `decode()` fuzz (protocol discrimination + caps). |
| `crates/quanta-image-decoder/fuzz/corpus/sixel/` | Seed corpus: real outputs + hand-crafted. |
| `crates/quanta-image-decoder/fuzz/corpus/iterm/` | Seed corpus. |
| `crates/quanta-image-decoder/fuzz/corpus/kitty/` | Seed corpus. |
| `crates/quanta-image-decoder/README.md` | Crate-level doc — API surface, security notes, contributing. |
| `ci/check-images-no-unwrap.sh` | Grep rule: no `unwrap`/`expect`/`panic!` in `crates/quanta-image-decoder/src/**`. |
| `ci/check-images-no-net.sh` | Grep rule: no `reqwest`/`hyper`/`std::net`/`tokio::net` in the crate. |

### 3.2 Out of scope

- VT engine parser integration — EPIC-B / C / D.
- Grid cell placement — EPIC-E.
- Render surface — EPIC-F.
- IndexedDB schema — EPIC-F.
- On-disk cache layout — EPIC-E (because session_id lives there).

---

## 4. Design

### 4.1 Public types

```rust
// crates/quanta-image-decoder/src/types.rs

/// Canonical output of a successful decode. The RGBA bytes are the single
/// source of truth for downstream placement + render.
#[derive(Clone, Debug)]
pub struct DecodedImage {
    /// Stable content hash. xxh3-128 over (rgba || width || height).
    pub content_hash: [u8; 16],
    /// Tightly-packed RGBA (4 bytes per pixel, row-major, top-down, no stride).
    pub rgba: bytes::Bytes,
    /// Decoded width in pixels. Always > 0.
    pub width_px: u32,
    /// Decoded height in pixels. Always > 0.
    pub height_px: u32,
    /// Inferred MIME (for storage tagging + UI).
    pub mime: Mime,
    /// Protocol that emitted the image (for telemetry + replay).
    pub protocol: Protocol,
    /// Hints extracted from the source protocol (aspect ratio, cursor policy, z-index).
    pub hints: ImageHints,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mime { Png, Jpeg, Gif, Bmp, Tiff, WebP, RawRgba, RawRgb, Sixel }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Protocol { Sixel, Iterm, Kitty }

#[derive(Clone, Copy, Debug, Default)]
pub struct ImageHints {
    pub preserve_aspect_ratio: bool,
    pub cursor_advance: CursorAdvance,
    pub z_index: i32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CursorAdvance {
    #[default] BelowImage,
    Stay,
    UserDefined { rows: u16, cols: u16 },
}
```

### 4.2 Error taxonomy

```rust
// crates/quanta-image-decoder/src/error.rs

#[derive(thiserror::Error, Debug)]
#[error("decode failed (protocol={protocol:?}, kind={kind:?})")]
pub struct DecodeError {
    pub kind: DecodeErrorKind,
    pub protocol: Protocol,
    pub at_offset: Option<usize>,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DecodeErrorKind {
    /// Wire-side size cap exceeded before decode started.
    WireTooLarge { limit: usize, actual: usize },
    /// Decoded pixel count exceeded cap.
    DecodedTooLarge { limit: usize, actual: usize },
    /// Single-dimension cap exceeded.
    DimensionTooLarge { axis: Axis, limit: u32, actual: u32 },
    /// MIME sniff failed; bytes don't match any supported format.
    UnknownMime,
    /// Malformed base64 payload.
    MalformedBase64,
    /// Sixel-specific: undefined palette index used.
    UndefinedPaletteIndex(u16),
    /// Sixel-specific: malformed DCS params.
    MalformedSixelParams,
    /// kitty-specific: unsupported transport (shm denied, file denied).
    UnsupportedTransport(KittyTransport),
    /// kitty-specific: chunk sequence invalid (gap / wrong order).
    MalformedChunkSequence,
    /// Upstream decoder (image crate) panicked; caught.
    Panicked { backtrace_hash: Option<[u8; 16]> },
    /// Upstream decoder returned a non-panic error.
    UpstreamDecodeFailure,
    /// Internal invariant violated (bug; filed against us).
    InternalInvariant(&'static str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Axis { Width, Height }
```

### 4.3 Decoder limits

```rust
// crates/quanta-image-decoder/src/limits.rs

#[derive(Clone, Copy, Debug)]
pub struct DecoderLimits {
    pub wire_bytes_max: usize,
    pub decoded_bytes_max: usize,
    pub width_px_max: u32,
    pub height_px_max: u32,
    pub total_pixels_max: u32,
}

impl Default for DecoderLimits {
    fn default() -> Self {
        Self {
            wire_bytes_max: 64 * 1024 * 1024,
            decoded_bytes_max: 32 * 1024 * 1024,
            width_px_max: 8192,
            height_px_max: 8192,
            total_pixels_max: 32 * 1024 * 1024 / 4,
        }
    }
}
```

### 4.4 Adapter trait

```rust
// crates/quanta-image-decoder/src/adapter.rs

pub trait ImageDecoderAdapter: Send + Sync {
    fn protocol(&self) -> Protocol;

    /// Decode the full payload. Implementations MUST:
    ///   - honor limits.wire_bytes_max before any allocation beyond O(1);
    ///   - refuse any single dimension > limits.*_max;
    ///   - refuse total_pixels > limits.total_pixels_max;
    ///   - never panic (panic-catcher in dispatch layer is a safety net, not permission).
    fn decode(
        &self,
        payload: &[u8],
        params: &AdapterParams,
        limits: &DecoderLimits,
    ) -> Result<DecodedImage, DecodeError>;
}

/// Protocol-specific params (sixel P1/P2/P3, iTerm key-values, kitty ctrl fields).
#[derive(Clone, Debug, Default)]
pub struct AdapterParams {
    pub sixel: Option<SixelParams>,
    pub iterm: Option<ItermParams>,
    pub kitty: Option<KittyParams>,
}
```

### 4.5 Top-level dispatch

```rust
// crates/quanta-image-decoder/src/dispatch.rs

pub fn decode(
    protocol: Protocol,
    payload: &[u8],
    params: &AdapterParams,
    limits: &DecoderLimits,
) -> Result<DecodedImage, DecodeError> {
    if payload.len() > limits.wire_bytes_max {
        hooks::count_size_cap_hit(protocol);
        return Err(DecodeError {
            kind: DecodeErrorKind::WireTooLarge { limit: limits.wire_bytes_max, actual: payload.len() },
            protocol, at_offset: None,
            message: "wire payload exceeds cap".into(),
        });
    }

    let adapter: &dyn ImageDecoderAdapter = match protocol {
        Protocol::Sixel => &sixel::SixelAdapter,
        Protocol::Iterm => &iterm::ItermAdapter,
        Protocol::Kitty => &kitty::KittyAdapter,
    };

    // Panic catcher — converts any panic inside the adapter into DecodeError::Panicked.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        adapter.decode(payload, params, limits)
    }));

    match result {
        Ok(inner) => inner,
        Err(payload) => {
            hooks::count_panic(protocol);
            let bt = hash::backtrace_hash(payload.as_ref());
            Err(DecodeError {
                kind: DecodeErrorKind::Panicked { backtrace_hash: bt },
                protocol, at_offset: None,
                message: "upstream decoder panicked".into(),
            })
        }
    }
}
```

### 4.6 Sixel adapter skeleton

State machine: `Idle → InDcsParams → InSixelBody → Terminated`. Owns a 256-slot palette `[Option<Rgb>; 256]` and a row-accumulator `Vec<Vec<u8>>` of width × 6 pixels. On `-` flush row; on `ESC \` finalize.

Width cap: 8192 px. RLE expansion checked against remaining width budget before allocation.

### 4.7 iTerm adapter skeleton

1. Strip `OSC 1337 ; File=` prefix and `BEL`/`ST` terminator (caller responsibility; adapter receives clean bytes + params).
2. Parse key-value pairs into `ItermParams`.
3. base64-decode payload with `base64::engine::general_purpose::STANDARD.decode` using streaming decoder; cap intermediate buffer at `wire_bytes_max`.
4. MIME-sniff decoded bytes.
5. Dispatch to `image::load_from_memory_with_format`.
6. Pre-decode dimension check (PNG/JPEG headers expose dims cheaply); reject if beyond caps.
7. Convert to RGBA8.
8. Compute hash.

### 4.8 kitty adapter skeleton

Chunking is caller concern (EPIC-D reassembles chunks before calling `decode`). Adapter receives assembled payload + `KittyParams`.

Paths:
- `f=32` (RGBA) — verify `len == width*height*4`, copy bytes.
- `f=24` (RGB) — verify `len == width*height*3`, expand to RGBA with alpha=255.
- `f=100` (PNG) — `image::load_from_memory_with_format(..., ImageFormat::Png)`.

Transport validation lives in EPIC-D (because it needs filesystem allowlist config); adapter assumes payload is present bytes.

### 4.9 Content-hash

```rust
// crates/quanta-image-decoder/src/hash.rs

pub fn content_hash(rgba: &[u8], width: u32, height: u32) -> [u8; 16] {
    use xxhash_rust::xxh3::xxh3_128;
    let mut buf = Vec::with_capacity(rgba.len() + 8);
    buf.extend_from_slice(rgba);
    buf.extend_from_slice(&width.to_le_bytes());
    buf.extend_from_slice(&height.to_le_bytes());
    xxh3_128(&buf).to_le_bytes()
}
```

### 4.10 Telemetry hooks

```rust
// crates/quanta-image-decoder/src/hooks.rs

pub(crate) fn count_decode_ok(p: Protocol) { /* quanta_metrics::counter!(...) */ }
pub(crate) fn count_decode_error(p: Protocol, kind: &DecodeErrorKind) { /* ... */ }
pub(crate) fn count_panic(p: Protocol) { /* ... */ }
pub(crate) fn count_size_cap_hit(p: Protocol) { /* ... */ }
pub(crate) fn record_decode_duration_ms(p: Protocol, ms: f64) { /* ... */ }
```

---

## 5. Definition of Done

1. Crate `quanta-image-decoder` compiles under `cargo check --all-features` and `--no-default-features`.
2. `ImageDecoderAdapter` trait exported and documented.
3. `DecodedImage`, `DecodeError`, `DecodeErrorKind`, `DecoderLimits`, `Protocol`, `Mime`, `ImageHints` all exported.
4. Sixel adapter decodes at least 10 real-world golden inputs (from `chafa`, `img2sixel`, `timg`) byte-identically (RGBA match + dim match).
5. iTerm adapter decodes at least 10 golden inputs (PNG/JPEG/GIF first frame) byte-identically.
6. kitty adapter decodes at least 10 golden inputs across RGBA/RGB/PNG paths byte-identically.
7. `decode()` entry returns `DecodeError::WireTooLarge` at exactly `wire_bytes_max + 1` bytes.
8. `decode()` entry returns `DecodeError::DecodedTooLarge` when dims would exceed the decoded cap.
9. `decode()` entry returns `DecodeError::DimensionTooLarge` at `width_px_max + 1`.
10. `decode()` entry returns `DecodeError::Panicked` when the injected-panic fixture is fed through — never propagates.
11. Content-hash is stable: same bytes → same hash on macOS aarch64 + Linux x86_64 + Linux aarch64 (CI matrix enforces).
12. CI grep `check-images-no-unwrap.sh` is green (zero `unwrap`/`expect`/`panic!` in `src/**`).
13. CI grep `check-images-no-net.sh` is green (zero network crates pulled into this crate).
14. `cargo-fuzz` target `fuzz_sixel` runs clean for 24 hours on CI (panic-free, memory bounded by RSS probe).
15. `cargo-fuzz` target `fuzz_iterm` runs clean for 24 hours.
16. `cargo-fuzz` target `fuzz_kitty` runs clean for 24 hours.
17. `cargo-fuzz` target `fuzz_dispatch` runs clean for 24 hours (exercises protocol discrimination + size caps).
18. README documents the public API, the security model, and the fuzz-corpus contribution workflow.
19. `DecoderLimits::default()` values match RFC 0003 §10.4 exactly.
20. Telemetry counters emit on every decode path (ok / error / panic / cap).
21. `image` crate version pinned in workspace; `Cargo.lock` committed.
22. No `unsafe` blocks without `// SAFETY:` comment (CI grep enforces).
23. Crate-level docstring in `lib.rs` explains the three-protocol coverage and links to RFC 0003.
24. Benchmarks (`criterion` optional bench target) for decode throughput — baseline documented.
25. Security review sign-off: Platform Lead approves ADR 0020 enforcement.

---

## 6. Quality Gates

- **Gate-1 — Fuzz panic-free.** All four fuzz targets must complete 24 hours of CI fuzz with zero panics. Non-negotiable.
- **Gate-2 — Memory bounded.** RSS probe during fuzz must not exceed 128 MB (double the 64 MB wire cap to allow temp decode buffers).
- **Gate-3 — Golden parity.** All golden fixtures produce exact RGBA + dim + hash match on CI matrix.
- **Gate-4 — Cap boundary correctness.** Exactly-at-cap accepts; cap+1 rejects with the right error kind.
- **Gate-5 — Panic catcher.** Injected-panic fixture returns `DecodeError::Panicked`, not process exit.
- **Gate-6 — Hash stability.** Same input → same 16-byte hash across 3 OS/arch targets.
- **Gate-7 — No-unwrap lint.** `grep -r 'unwrap\|expect\|panic!' crates/quanta-image-decoder/src/` returns zero non-comment lines.

---

## 7. E2E tests (≥ 5)

1. **E2E-1 — sixel PNG round-trip.** A known PNG is converted to sixel with `img2sixel`; `decode(Protocol::Sixel, bytes, ...)` produces RGBA within ≤ 2% per-pixel tolerance of the original PNG.
2. **E2E-2 — iTerm PNG passthrough.** A PNG is base64-encoded and wrapped in the OSC 1337 envelope; decoder produces the original PNG's RGBA byte-identical.
3. **E2E-3 — kitty RGBA direct.** Raw RGBA of a 100×100 image is submitted; decoder returns the same bytes, correct dims, `Mime::RawRgba`.
4. **E2E-4 — decoder bomb rejection.** A 200 MB base64 blob is fed through iTerm adapter; decoder returns `WireTooLarge` within 10 ms, no allocation beyond 64 MB.
5. **E2E-5 — concurrent decode throughput.** 16 worker threads call `decode()` simultaneously with mixed protocols; throughput ≥ 10 images/sec aggregate on baseline CI hardware.
6. **E2E-6 — injected-panic containment.** Fixture known to panic in `image` crate is submitted; return is `DecodeError::Panicked`, process continues.
7. **E2E-7 — content-hash dedup.** Same PNG submitted via iTerm and kitty PNG path produces the same `content_hash`.

---

## 8. Tests

### 8.1 Unit tests

- `types::*` — round-trip `DecodedImage` clone equality.
- `error::*` — Display impl matches expected strings.
- `limits::*` — default matches spec constants.
- `hash::*` — known-vector test (hand-computed).
- `sixel::parse_params` — 10 parameter permutations.
- `sixel::palette_define` — define / redefine / undefined-use all covered.
- `sixel::rle_cap` — `!65535~` hits width cap cleanly, no OOM.
- `iterm::key_value_decode` — every documented key + edge cases (duplicate keys, missing values).
- `iterm::base64_stream` — partial, padded, unpadded, URL-safe variants.
- `kitty::raw_rgba_length_check` — len mismatch rejected.
- `kitty::png_header_dim_read` — dims extracted without full decode.
- `kitty::transport_validation` — `t=d` accepted, `t=f` / `t=s` rejected at adapter layer (EPIC-D re-gates).

### 8.2 Integration tests

- `tests/sixel_decode.rs` — 20+ golden inputs.
- `tests/iterm_decode.rs` — 15+ golden inputs.
- `tests/kitty_decode.rs` — 15+ golden inputs.
- `tests/size_cap.rs` — 10 cap-boundary cases.
- `tests/panic_catch.rs` — 3 known-panic fixtures.
- `tests/hash_stability.rs` — 5 inputs hashed on CI matrix.

### 8.3 Fuzz tests

- `fuzz_sixel.rs`, `fuzz_iterm.rs`, `fuzz_kitty.rs`, `fuzz_dispatch.rs` — all invariants from §11.
- Nightly CI runs 24 h; PR CI runs 10 min.

---

## 9. Failure modes

- **F-1 — Sixel RLE expansion OOM.** Attack: `!4294967295~`. Defense: width cap check before allocation; error `DecodeErrorKind::DimensionTooLarge`.
- **F-2 — Sixel palette redefine loop.** Attack: repeatedly redefine palette entry 0. Defense: redefinition allowed, but palette is bounded (256 entries); no growth.
- **F-3 — Sixel `-` spam (row advance).** Attack: millions of `-` chars → row count blows up. Defense: height cap check per `-`.
- **F-4 — iTerm base64 all-whitespace.** Attack: 64 MB of spaces decodes to nothing. Defense: decoder accepts empty result; caller sees `UnknownMime` on empty payload.
- **F-5 — iTerm payload claims size=huge, actual bytes small.** Attack: `size=999999999` with tiny payload. Defense: `size` is decorative; payload length is authoritative.
- **F-6 — iTerm PNG header claims 10000×10000.** Defense: pre-decode dim check against `width_px_max` / `height_px_max`.
- **F-7 — kitty `f=32 s=10 v=10` with 1000 bytes of payload.** Defense: exact length check `s*v*4 == payload_len` required.
- **F-8 — kitty PNG payload.** Defense: `image` crate path + panic catcher + dim pre-check.
- **F-9 — Unknown protocol tag.** Defense: `decode()` signature takes `Protocol` enum — cannot pass unknown; compile-time guard.
- **F-10 — Multithread panic-catcher race.** Defense: `catch_unwind` is thread-local; no shared state; documented.
- **F-11 — Panic in hash computation.** Defense: xxh3 library is no-panic documented; we test with empty / huge inputs anyway.
- **F-12 — Allocator fails (OOM).** Defense: Rust's default `alloc` aborts the process. We set a custom allocator guard in the fuzz harness to convert to `DecodeError` there; in production we accept the abort (user sees terminal restart) as the baseline — documented in ADR 0020.
- **F-13 — Protocol misconfigured (e.g., `decode(Kitty, sixel_bytes)`).** Defense: adapter rejects on format sniff; returns `UnknownMime`.
- **F-14 — Concurrent modification of `DecoderLimits`.** Defense: `DecoderLimits` is `Copy`; callers pass by value.
- **F-15 — Telemetry counter saturation.** Defense: counter overflow wraps (acceptable; this is metrics, not business logic).

---

## 10. Risks

- **R-A1 — `image` crate CVE lands mid-epic.** Mitigation: pin version; subscribe to RustSec advisory; ADR 0020 includes CVE-response SLA.
- **R-A2 — Fuzz finds unfixable panics in `image`.** Mitigation: panic-catcher is the safety net; document and move on, file upstream.
- **R-A3 — Content-hash collision.** Mitigation: 128-bit hash → collision probability <<1 per session lifetime for any realistic attack; per-session keying in cache.
- **R-A4 — `xxhash-rust` MSRV mismatch.** Mitigation: version pinned; pre-PR compile check on MSRV runner.
- **R-A5 — Fuzz slow on CI.** Mitigation: 10-min on PR, 24-h nightly; corpora seeded so fuzz finds quickly.
- **R-A6 — Decoder is a compile-time hotspot.** Mitigation: behind `full-decode` feature; consumers that only need placeholder don't pay the `image` crate compile cost.

---

## 11. Rollback

- Feature flag `experimental.images` gates everything downstream; setting `off` neutralizes the decoder path.
- Crate can be deleted with only `quanta-proto::Protocol` stub remaining; no other crate links against it until EPIC-B.
- Golden fixtures and fuzz corpus live in-tree; rollback preserves them for future re-enable.

---

## 12. Cross-refs

- RFC 0003 §7.2 — crate charter.
- RFC 0003 §10 — security.
- RFC 0003 §11 — storage (consumes content-hash produced here).
- RFC 0003 §12 — performance budgets.
- RFC 0003 §16 — telemetry counter names.
- RFC 0003 §24.1 — editorial on why-a-crate.
- ADR 0019 — event envelope (consumed by EPIC-E).
- ADR 0020 — decoder sandbox + CVE-response SLA.
- ADR 0021 — cell semantics (consumed by EPIC-E).
- RFC 0001 §2 I-8 — no black screen (panic catcher upholds this invariant).

---

## 13. Day-by-day

### Week 1

- **Mon** — Scaffold crate + CI jobs + manifest. Land `types.rs`, `error.rs`, `limits.rs`, `adapter.rs`, `hooks.rs`, `hash.rs`. CI grep rules added and green on empty crate.
- **Tue** — `dispatch.rs` with panic-catcher; unit tests for cap enforcement. Fixture-corpus directory created; 5 seed sixel inputs committed.
- **Wed** — Sixel adapter scaffold: params parser + DCS terminator handling. Unit tests for param permutations.
- **Thu** — Sixel palette + RLE + row accumulator; 10 golden sixel decodes pass.
- **Fri** — Sixel remaining 10 golden inputs; start sixel fuzz target.

### Week 2

- **Mon** — iTerm adapter: key-value decoder + base64 stream. 5 golden PNG inputs pass.
- **Tue** — iTerm PNG/JPEG/GIF first-frame dispatch; 15 golden inputs pass. Pre-decode dim check.
- **Wed** — kitty adapter: RGBA/RGB raw paths + length checks; 5 golden inputs pass.
- **Thu** — kitty PNG path + transport validation sketch; 10 golden inputs pass. Remaining 5 inputs + hash-stability test across OS/arch CI matrix.
- **Fri** — All fuzz targets wired; 10-min PR fuzz green; nightly 24-h fuzz kicked off. Docs + README + security review sign-off scheduled Monday of week 3.

### Soak week (shared with EPIC-B/C/D kickoff)

- Nightly fuzz completes clean ×7.
- Golden corpus expanded to ≥ 50 total.
- `cargo doc` publishes crate docs to internal docs site.
- EPIC-B/C/D kickoff reads the adapter trait — design-ahead parallel work begins.

---

End of EPIC-A design.
