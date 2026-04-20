# EPIC-D Design — kitty Graphics Protocol Parser

- **Status**: Design-ahead (Gear 3). Freezes the APC G chunked-protocol state machine, placement tracker, response-APC emitter, and file-path / shared-memory transport gate.
- **Date**: 2026-04-20
- **Related**: RFC 0003 §5.3 (kitty protocol reference), §7.1 (component layout), §9 (parse-politely), §10 (security — file allowlist + shm denial), §13.3 (reflow semantics — kitty placement re-eval), EPIC-A (decoder adapter), RFC 0001 §5 (VT engine authority), §7.4 (event envelope), ADR 0020 (sandbox contract).
- **Blocks**: EPIC-E (grid integration).

One-paragraph read: kitty's graphics protocol is the richest of the three — chunked APC transmission, out-of-band placements, z-order, source crops, animation frames, file-path and shared-memory transports, and an explicit response protocol. This epic owns all protocol-level state: per-image chunk reassembly, placement-id tracking, response emission, transport validation, and animation-frame dropping (v1 strips animations to first frame). The actual pixel decode happens in EPIC-A; this epic produces a `RawImagePayload` once chunks are assembled and transport is resolved. Security is the biggest design constraint: the `t=f` file-path and `t=s` shared-memory transports are default-denied unless the user opts in via an allowlist. This is the largest epic in RFC 0003 (2.5 weeks) because of protocol surface breadth, not decode complexity.

---

## 1. Summary

- **Goal**: Parse `ESC _ G <ctrl> ; <payload> ESC \` (APC_G) sequences, reassemble chunks per `m=` flag, validate transport against allowlist, dispatch to decoder, track placements, emit responses per kitty spec, and maintain the image-id → blob map.
- **Phase**: 2 (per RFC 0003 §17).
- **Duration**: 2.5 weeks.
- **Dependencies**: EPIC-A spec-freeze. RFC 0001 EPIC-B APC handling hook available. ADR 0020 file-allowlist config field wired.
- **Owner**: VT Engine squad.

### 1.1 Contracts frozen

- `KittyGraphicsParser` public API.
- `KittyParams` struct (ctrl fields).
- `KittyChunkAssembler` — per-image-id buffer with timeout.
- `KittyPlacementTracker` — active placements per session.
- Response APC emitter — format + outgoing-byte contract.
- Transport-validation rule table.
- Animation-frame drop policy (v1).

### 1.2 Contracts consumed

- `quanta_image_decoder::Protocol::Kitty`, `DecoderLimits`, `DecodeError`.
- `quanta_vt::Grid::advance_cursor_after_image`.
- `quanta_vt::ImageDispatchQueue`.
- `security::FilePathAllowlist` (config).
- `security::SharedMemoryPolicy` (config).

---

## 2. Background

### 2.1 kitty protocol recap

**Envelope**: `ESC _ G <ctrl-csv> ; <payload-chunk> ESC \`

- `<ctrl-csv>` — comma-separated `key=value` pairs (e.g., `a=T,f=100,s=640,v=480,i=42`).
- `<payload-chunk>` — base64-encoded chunk OR empty for control-only commands.

Multi-chunk transmission:
- All chunks except the last carry `m=1`; final chunk carries `m=0` (or omitted entirely).
- All chunks for the same image share `i=<id>` (or `I=<number>`).
- Chunks may interleave with unrelated commands; assembler keys by `i`.

Actions (`a=`):
- `t` — transmit data only; store keyed by `i`.
- `T` — transmit + display immediately at current cursor.
- `p` — put (display existing blob by `i` at a new placement).
- `d` — delete placement or image (optional `d=<scope>`).
- `f` — frame — add frame to animation (v1 drops).
- `q` — query support.

Transport (`t=`):
- `d` — direct, payload is the bytes.
- `f` — file path (payload = base64 of filename).
- `t` — temp file (delete after read).
- `s` — shared memory segment name.

Formats (`f=`):
- `32` — RGBA.
- `24` — RGB.
- `100` — PNG.

Placement keys:
- `i`, `I`, `p` — image id / image number / placement id.
- `r`, `c` — rows/cols span in cells.
- `z` — z-index (signed 32-bit).
- `C` — cursor-advance policy (`0` = move below, `1` = stay).
- `x`, `y`, `w`, `h` — source crop rect.

### 2.2 Why this is the hardest epic

- Ctrl field set is large and extensible.
- Chunked reassembly must handle interleaving + timeouts.
- Transport security is critical.
- Response protocol (bi-directional) — we must emit APC_G responses back up the PTY to the program, which is a new write-back path.
- Placement tracker is stateful across the session lifetime.

---

## 3. Scope

### 3.1 Files

| File | Purpose |
|------|---------|
| `crates/quanta-vt/src/parsers/kitty_graphics.rs` | New. `KittyGraphicsParser` main entry. |
| `crates/quanta-vt/src/parsers/kitty_ctrl.rs` | New. Ctrl-csv parser + `KittyParams`. |
| `crates/quanta-vt/src/parsers/kitty_chunks.rs` | New. `KittyChunkAssembler`. |
| `crates/quanta-vt/src/parsers/kitty_placements.rs` | New. `KittyPlacementTracker`. |
| `crates/quanta-vt/src/parsers/kitty_responses.rs` | New. Response APC emitter. |
| `crates/quanta-vt/src/parsers/kitty_transport.rs` | New. Transport resolution + allowlist check. |
| `crates/quanta-vt/src/dispatch/kitty.rs` | New. APC dispatch hook. |
| `crates/quanta-vt/src/image_dispatch.rs` | Updated (shared). Add `KittyParams`. |
| `crates/quanta-vt/src/config.rs` | Updated. `FilePathAllowlist`, `SharedMemoryPolicy`. |
| `crates/quanta-vt/tests/kitty_parse.rs` | 20+ golden APC captures. |
| `crates/quanta-vt/tests/kitty_chunks.rs` | Reassembly scenarios. |
| `crates/quanta-vt/tests/kitty_placements.rs` | Placement lifecycle. |
| `crates/quanta-vt/tests/kitty_responses.rs` | Response APC byte-exact output. |
| `crates/quanta-vt/tests/kitty_transport.rs` | Allowlist + shm denial tests. |
| `crates/quanta-vt/tests/kitty_parse_fixtures/` | Real `kitten icat` + `image.nvim` captures. |
| `crates/quanta-vt/fuzz/fuzz_targets/fuzz_kitty_parser.rs` | State-machine fuzz. |
| `docs/adr/0020-decoder-sandbox.md` | Referenced (not edited in this epic). |

### 3.2 Out of scope

- Pixel decoding (EPIC-A).
- Grid cell placement (EPIC-E).
- Render (EPIC-F).
- Sixel / iTerm parsers.
- Animation beyond frame-0 (deferred to v2 per RFC 0003 §6).
- Streaming transmit (`stream=1` — deferred).

---

## 4. Design

### 4.1 Ctrl-csv parser

```rust
// crates/quanta-vt/src/parsers/kitty_ctrl.rs

#[derive(Clone, Debug, Default)]
pub struct KittyParams {
    pub action: KittyAction,
    pub format: KittyFormat,
    pub transport: KittyTransport,
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
    pub image_id: Option<u32>,
    pub image_number: Option<u32>,
    pub placement_id: Option<u32>,
    pub quiet: u8,                // 0/1/2
    pub more_chunks: bool,        // m=1
    pub cell_rows: Option<u16>,
    pub cell_cols: Option<u16>,
    pub z_index: i32,
    pub cursor_movement: CursorMovement,
    pub src_crop: Option<SrcCrop>,
    pub compression: KittyCompression,
    pub frame: Option<FrameParams>,  // a=f
}

#[derive(Clone, Copy, Debug, Default)]
pub enum KittyAction {
    #[default] Transmit,
    TransmitAndDisplay,
    Put,
    Delete { scope: DeleteScope },
    Frame,
    Query,
}

#[derive(Clone, Copy, Debug, Default)]
pub enum KittyFormat {
    #[default] Rgba,   // f=32
    Rgb,               // f=24
    Png,               // f=100
}

#[derive(Clone, Copy, Debug, Default)]
pub enum KittyTransport {
    #[default] Direct,      // t=d
    File,                   // t=f
    TempFile,               // t=t
    SharedMemory,           // t=s
}

#[derive(Clone, Copy, Debug, Default)]
pub enum KittyCompression {
    #[default] None,
    Zlib,                   // o=z
}
```

Parser: split on `,`; each entry `key=value`; key is one letter; value type-dispatched. Unknown keys ignored with counter.

### 4.2 Chunk assembler

```rust
// crates/quanta-vt/src/parsers/kitty_chunks.rs

pub struct KittyChunkAssembler {
    // Per-image-id buffer.
    pending: lru::LruCache<u32, PendingImage>,
    max_pending: usize,      // 16 default; configurable.
    chunk_timeout: Duration, // 5s default.
}

struct PendingImage {
    params: KittyParams,     // params from first chunk; later chunks share id only.
    payload: BytesMut,
    started_at: Instant,
    last_chunk_at: Instant,
}

impl KittyChunkAssembler {
    pub fn ingest(&mut self, params: KittyParams, payload: &[u8])
        -> Result<IngestOutcome, ChunkError>;
}

pub enum IngestOutcome {
    Pending,                              // m=1; more chunks expected.
    Complete(AssembledImage),             // m=0; full payload assembled.
    Duplicate,                            // chunk replaces pending (protocol variant).
    Overflow,                             // cap hit; placeholder downstream.
    Expired,                              // timeout; discarded.
}

pub struct AssembledImage {
    pub params: KittyParams,
    pub payload: Bytes,
}
```

Timeout sweep runs on every `ingest` call (opportunistic GC). Separate background task not required.

### 4.3 Placement tracker

```rust
// crates/quanta-vt/src/parsers/kitty_placements.rs

pub struct KittyPlacementTracker {
    // image_id → blob_ref + metadata.
    images: HashMap<u32, TrackedImage>,
    // (image_id, placement_id) → placement.
    placements: HashMap<(u32, u32), Placement>,
    max_images_per_session: usize,       // 1024 default.
    max_placements_per_image: usize,     // 256 default.
}

pub struct TrackedImage {
    pub blob_ref: BlobRef,
    pub width_px: u32,
    pub height_px: u32,
    pub last_access: Instant,
}

pub struct Placement {
    pub image_id: u32,
    pub placement_id: u32,
    pub anchor: CellAnchor,
    pub cell_span: CellSpan,
    pub z_index: i32,
    pub src_crop: Option<SrcCrop>,
}

impl KittyPlacementTracker {
    pub fn record_image(&mut self, id: u32, blob: BlobRef, w: u32, h: u32);
    pub fn add_placement(&mut self, p: Placement) -> Result<(), PlacementError>;
    pub fn delete(&mut self, scope: DeleteScope);
    pub fn get(&self, image_id: u32, placement_id: u32) -> Option<&Placement>;
    pub fn evict_oldest_image(&mut self);  // when cap hit.
}
```

### 4.4 Response emitter

```rust
// crates/quanta-vt/src/parsers/kitty_responses.rs

pub struct KittyResponseEmitter {
    // Write-back handle to the PTY master (writes bytes back *up* the terminal to the program).
    writer: Arc<dyn PtyWriter>,
}

impl KittyResponseEmitter {
    pub fn emit_ok(&self, image_id: u32, placement_id: Option<u32>);
    pub fn emit_error(&self, image_id: u32, placement_id: Option<u32>, err: KittyResponseCode);
    pub fn emit_query_capabilities(&self, id: u32);
}

#[derive(Clone, Copy, Debug)]
pub enum KittyResponseCode {
    Ok,
    Eio,
    Enoent,
    Einval,
    Enotsup,
    Eoverflow,
}

// On the wire: "ESC _ G i=<id>[,p=<pid>];<code> ESC \"
```

Quiet level (`q=`):
- `q=0` — send all responses.
- `q=1` — suppress OK; send errors.
- `q=2` — suppress everything.

### 4.5 Transport resolution

```rust
// crates/quanta-vt/src/parsers/kitty_transport.rs

pub fn resolve_transport(
    params: &KittyParams,
    payload: &[u8],
    allowlist: &FilePathAllowlist,
    shm_policy: &SharedMemoryPolicy,
) -> Result<Bytes, TransportError> {
    match params.transport {
        KittyTransport::Direct => Ok(Bytes::copy_from_slice(payload)),
        KittyTransport::File => {
            let path_b64 = std::str::from_utf8(payload).map_err(|_| TransportError::BadPath)?;
            let path = base64::decode(path_b64).map_err(|_| TransportError::BadPath)?;
            let path = PathBuf::from(OsString::from_vec(path));
            let canon = std::fs::canonicalize(&path).map_err(|_| TransportError::NotFound)?;
            if !allowlist.contains(&canon) {
                return Err(TransportError::Denied);
            }
            let bytes = std::fs::read(&canon).map_err(|_| TransportError::Io)?;
            if bytes.len() > MAX_FILE_BYTES { return Err(TransportError::TooLarge); }
            Ok(Bytes::from(bytes))
        }
        KittyTransport::TempFile => {
            // Same as File, but delete after read.
            // ...
        }
        KittyTransport::SharedMemory => {
            if !shm_policy.enabled { return Err(TransportError::Denied); }
            // v1 default: shm_policy.enabled = false → always Denied.
            Err(TransportError::Denied)
        }
    }
}
```

### 4.6 Main parser orchestration

```rust
// crates/quanta-vt/src/parsers/kitty_graphics.rs

pub struct KittyGraphicsParser {
    assembler: KittyChunkAssembler,
    placements: KittyPlacementTracker,
    responses: KittyResponseEmitter,
    allowlist: FilePathAllowlist,
    shm_policy: SharedMemoryPolicy,
    limits: DecoderLimits,
}

impl KittyGraphicsParser {
    /// Called by APC dispatch with the full APC body (between ESC_G and ESC\).
    pub fn handle_apc(&mut self, body: &[u8]) -> ApcOutcome;
}

pub enum ApcOutcome {
    QueuedForDecode(RawImagePayload),  // full image → decoder
    PlacementOnly(Placement),          // reuse existing blob
    ChunksPending,                     // more chunks expected
    Deleted,
    QueryResponseSent,
    Error(ApcError),                   // response emitted; placeholder queued
}
```

Dispatch flow (happy path for `a=T`):
1. Split body on first `;` → ctrl_str, payload_str.
2. Parse ctrl_str → `KittyParams`.
3. Validate transport vs. allowlist/shm_policy.
4. Base64-decode payload (if format requires).
5. Feed to chunk assembler.
6. On `m=0`: produce `AssembledImage` → enqueue `RawImagePayload` → track placement → emit OK response.
7. On `m=1`: return `ChunksPending`; no event.
8. Cursor advance per `C=` flag.

### 4.7 Animation handling (v1 strip)

- `a=f` (frame append) — accept + drop with telemetry counter.
- Send OK response (program doesn't see that we dropped the frame).
- First-frame-only display: the initial `a=T` placement stays; subsequent frames are no-ops.

### 4.8 Cursor advance

- `C=0` — cursor moves to row below image (default).
- `C=1` — cursor stays.
- Row count = `r=` param if present; else computed post-decode from `height_px`.

### 4.9 Flag interaction

- `off` — parse + chunk-assemble + transport-validate, but drop the assembled image before enqueue; responses emitted; cursor advance preserved.
- `stripped-placeholder` — enqueue with `decode_mode=PlaceholderOnly`.
- `full` — enqueue with `decode_mode=Full`.

---

## 5. Definition of Done

1. `KittyGraphicsParser` exported + documented.
2. Ctrl-csv parser covers every key in RFC 0003 §5.3.
3. Chunk assembler correctly reassembles multi-chunk images with interleaved unrelated commands.
4. Chunk timeout (5s default) evicts stale pending images.
5. Pending-image cap (16 default) evicts oldest on overflow with telemetry counter.
6. Transport `t=d` → direct bytes.
7. Transport `t=f` → allowlist-checked; canonicalized; symlink-resolved; rejected if outside allowlist.
8. Transport `t=t` → allowlist-checked; file deleted after read.
9. Transport `t=s` → default-denied; telemetry counter `image.security.shm_denied`.
10. Response emitter writes back to PTY with correct APC_G envelope.
11. Response quiet levels honored (0/1/2).
12. Placement tracker records images + placements + lifetimes.
13. `a=d` (delete) with scopes (`all`, `by-id`, `by-placement`, `intersecting-cursor`) honored.
14. `a=f` (frame) accepted + dropped + OK response.
15. `a=q` (query) responds with capabilities.
16. Cursor-advance `C=0` / `C=1` honored.
17. `r=` / `c=` cell-span hints propagated to payload.
18. `z=` z-index propagated.
19. Source-crop `x,y,w,h` propagated.
20. 20+ golden fixtures parse cleanly with correct state transitions.
21. Fuzz target runs 24 h CI panic-free.
22. File-path escape attempts (`../`, symlinks) caught by canonicalize + prefix check.
23. No `unwrap`/`expect` in parser code.
24. Telemetry counters: parse errors, chunks pending, chunk timeouts, placement evictions, transport rejections, frame drops, query responses.
25. All three flag modes exercised in tests.

---

## 6. Quality Gates

- **Gate-1 — `kitten icat` parity.** 100% key-recovery across 10 captures from `kitten icat` with various options.
- **Gate-2 — `image.nvim` parity.** 100% key-recovery across 10 captures from neovim's image.nvim.
- **Gate-3 — Chunk reassembly.** 5 interleaved-chunk scenarios parse correctly.
- **Gate-4 — Response bytes exact.** Response APCs byte-identical to kitty spec examples.
- **Gate-5 — Fuzz panic-free.** 24 h run zero panics.
- **Gate-6 — Security: allowlist enforced.** All `../` / symlink attacks rejected.
- **Gate-7 — Security: shm denied by default.** `t=s` returns `ENOTSUP` response.

---

## 7. E2E tests (≥ 5)

1. **E2E-D1 — `kitten icat image.png`.** Full APC_G round-trip; `RawImagePayload` has correct params; response = OK.
2. **E2E-D2 — `image.nvim` render.** Multi-chunk PNG transmission; reassembled correctly; placement recorded; cursor stays (`C=1`).
3. **E2E-D3 — Delete placement.** `a=d, d=i, i=42` → placement removed; response = OK.
4. **E2E-D4 — File-path escape attempt.** `t=f` with `/etc/passwd` → response = `ENOENT` or `EACCES`; no file read.
5. **E2E-D5 — Shared memory denial.** `t=s, S=foo` → response = `ENOTSUP`; telemetry counter incremented.
6. **E2E-D6 — Chunk timeout.** Start a multi-chunk image, never send `m=0`, wait 6 seconds → pending image evicted; subsequent unrelated image unaffected.
7. **E2E-D7 — Animation frame drop.** `a=T` + `a=f,a=f,a=f` → first frame rendered; subsequent frames dropped with OK responses; telemetry counter `image.kitty.frame_drop` = 3.
8. **E2E-D8 — Query response.** `a=q` → engine writes back correct capability CSV.
9. **E2E-D9 — Chunk overflow.** Open 17 pending chunked images → oldest evicted; telemetry counter `image.kitty.pending_evict` = 1.

---

## 8. Tests

### 8.1 Unit

- Ctrl-csv parse: 30 permutations.
- `KittyParams::from_csv`: missing keys, unknown keys, malformed values, negative z.
- Chunk assembler: single-chunk, 2-chunk, 5-chunk, interleaved, duplicate, overflow, timeout.
- Placement tracker: add, delete by scope, evict, lookup.
- Response emitter: OK, each error code, quiet level 0/1/2 filter.
- Transport: each transport mode + allowlist match/no-match/symlink/non-existent.

### 8.2 Integration

- 20+ golden APC captures.
- Cross-flag matrix (`off`/`stripped-placeholder`/`full`) × 5 fixtures.

### 8.3 Fuzz

- `fuzz_kitty_parser.rs`:
  - Invariants: no panic, pending cap ≤ 16 × wire_bytes_max, placement cap ≤ 1024, terminates in < 100 ms for 1 MB ctrl+payload.
  - Corpus: real captures + pathological (256 chunks same id, interleaved escapes, malformed csv, oversized ids).

---

## 9. Failure modes

- **F-D1 — Ctrl-csv with binary bytes.** Defense: non-UTF-8 csv → parse error + placeholder.
- **F-D2 — Missing `a=`.** Defense: default `a=t`.
- **F-D3 — `a=X` (unknown action).** Defense: parse error + `EINVAL` response.
- **F-D4 — `i` + `I` both present.** Defense: `i` wins; telemetry counter.
- **F-D5 — Chunk with different params than first chunk.** Defense: params from first chunk win; telemetry counter.
- **F-D6 — Concurrent chunked transfers.** Defense: assembler keyed by `i`, supports interleaving.
- **F-D7 — Chunk for unknown `i` with `m=0`.** Defense: treat as single-chunk standalone image.
- **F-D8 — Very large `z` (near i32::MAX).** Defense: accepted; z-compare uses signed.
- **F-D9 — `a=q` without `i`.** Defense: `i=0` default; respond with capabilities.
- **F-D10 — Response write-back fails.** Defense: log telemetry; don't crash; drop response; image still displayed.
- **F-D11 — PTY write-back races engine read.** Defense: PTY master write is single-consumer; serialized.
- **F-D12 — File symlink to /etc/passwd.** Defense: canonicalize resolves symlinks; prefix-check against allowlist still catches.
- **F-D13 — File path with `..` segments.** Defense: canonicalize resolves; prefix-check.
- **F-D14 — TempFile transport, file vanishes mid-read.** Defense: `Io` error → `EIO` response + placeholder.
- **F-D15 — Shared-memory name contains null bytes.** Defense: denied at transport layer; no shm open attempted.
- **F-D16 — Zlib bomb (`o=z`).** Defense: decompressed-size cap = `wire_bytes_max`; bomb truncates.
- **F-D17 — Placement id conflict.** Defense: new placement replaces old; telemetry counter.
- **F-D18 — Query response before any image.** Defense: `i=0` allowed; capabilities returned.
- **F-D19 — Chunk assembler memory exhaustion.** Defense: per-image payload cap + pending-image cap.
- **F-D20 — Animation frame id conflict.** Defense: frames dropped; id ignored.

---

## 10. Risks

- **R-D1 — Protocol spec drift.** Mitigation: pinned to kitty 0.33 spec (2024-10); v1.1 revisits.
- **R-D2 — `image.nvim` uses undocumented quirks.** Mitigation: golden corpus captures real usage; document quirks; file upstream.
- **R-D3 — PTY write-back breaks existing input flow.** Mitigation: write-back channel is separate from user-input channel; no interference.
- **R-D4 — File allowlist misconfig.** Mitigation: validator warns on root / home / wildcard entries; docs stress least-privilege.
- **R-D5 — Shared-memory opt-in encourages risky configs.** Mitigation: default-off; docs link to security audit findings.
- **R-D6 — Chunk reassembly OOM under attack.** Mitigation: 16 pending × 64 MB each = 1 GB theoretical; per-image-payload cap additionally enforced; in practice RSS stays < 200 MB.
- **R-D7 — Animation-frame drop creates visible jitter.** Acceptable in v1; v2 roadmap implements playback.
- **R-D8 — Placement z-order interacts with block overlay.** Mitigation: EPIC-E handles interplay; kitty z-index is local to the image plane.

---

## 11. Rollback

- Remove APC_G handler from APC dispatch table in `dispatch/kitty.rs`.
- Placement tracker + chunk assembler compile but are never invoked.
- `kitten icat` visibly broken; engine stable.
- File-allowlist config entry remains (used by v1.1 if we re-enable safely).

---

## 12. Cross-refs

- RFC 0003 §5.3 — kitty protocol reference.
- RFC 0003 §10 — security (file allowlist, shm denial).
- RFC 0003 §13.3 — reflow (kitty re-evaluates placement).
- EPIC-A §4.8 — kitty decoder adapter.
- EPIC-B §4.6 — shared `image_dispatch` module.
- EPIC-E — grid integration consumes placements.
- RFC 0001 §7.4 — event envelope.
- ADR 0020 — decoder sandbox contract (file allowlist lives here).

---

## 13. Day-by-day

### Week 1

- **Mon** — Scaffold all new files. Ctrl-csv parser + `KittyParams`. Unit tests for 20 ctrl permutations.
- **Tue** — Chunk assembler + tests (single-chunk, multi-chunk, interleaved, timeout).
- **Wed** — Placement tracker + tests. `a=d` scopes.
- **Thu** — Response emitter + byte-exact tests. Quiet-level filter. Write-back plumbing.
- **Fri** — Transport resolver + allowlist tests + shm denial tests.

### Week 2

- **Mon** — APC dispatch integration. 5 golden `kitten icat` fixtures green.
- **Tue** — `image.nvim` captures + remaining 15 golden fixtures.
- **Wed** — Animation drop + telemetry. `a=q` query response.
- **Thu** — Fuzz target + 10-min PR fuzz green. Nightly 24-h fuzz kicked off.
- **Fri** — Cross-flag matrix tests; docs.

### Week 2.5

- **Mon** — Fuzz soak + fix any findings.
- **Tue** — CI grep rules green. Merge. EPIC-E unblocked.
- **Wed** — Contingency.

---

End of EPIC-D design.
