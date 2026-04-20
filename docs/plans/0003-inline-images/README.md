# RFC 0003 — Epic Plan

Companion to [RFC 0003](../../rfc/0003-inline-images.md). Breaks inline-image support into 6 epics with explicit dependencies, acceptance gates mapped to RFC sections, and a parallel-execution strategy that lets the decoder crate (Epic A) land ahead of VT-engine integration.

- **Status**: Proposed (companion to RFC 0003 v1)
- **Date**: 2026-04-20

---

## 0. Epic map

6 epics — 4 core + 2 integration. Sequencing chosen so the decoder crate (which has the biggest fuzz/security surface) lands first and can stabilize before VT-engine parsers call into it.

| Epic | Title | Phase | Duration | Blocks on | Freezes contract |
|------|-------|-------|----------|-----------|------------------|
| **A** | Image Decoder Crate | 1 | 2w | RFC 0003 §10 security spec, `quanta-proto` image types | `DecodedImage`, `DecodeError`, adapter trait, fuzz harness |
| **B** | Sixel Protocol Parser | 2 | 1.5w | A (trait freeze) | Sixel state-machine API, palette table shape |
| **C** | iTerm Inline Images Parser | 2 | 1w | A (trait freeze) | OSC 1337 key-value decoder, base64 streaming contract |
| **D** | kitty Graphics Protocol Parser | 2 | 2.5w | A (trait freeze) | APC G chunked-protocol state, placement tracker, response emitter |
| **E** | Grid Integration | 3 | 1.5w | B, C, D (parse emit) + RFC 0001 EPIC-B (Grid), EPIC-C (Mirror) | `ImageAnchor` / `ImageContinuation` cell kinds; `ImageEmitted` / `ImagePlacementUpdated` / `ImageRemoved` event envelope |
| **F** | Renderer Integration | 4 | 1.5w | E + RFC 0001 EPIC-D (renderer backend) | `drawImage`, `removeImage`, `onImageLoaded` in BackendContract; IndexedDB schema |

**Total parallel wall-clock**: ~6-7 weeks. Sequential would be ~10 weeks.

## 1. Dependency graph

```
              ┌─────┐
              │  A  │ Decoder Crate (Phase 1)
              └──┬──┘
                 │ freezes DecodedImage + adapter trait
                 │
       ┌─────────┼──────────┐
       ▼         ▼          ▼
    ┌─────┐  ┌─────┐    ┌─────┐
    │  B  │  │  C  │    │  D  │  (Phase 2 — parallel parser epics)
    └──┬──┘  └──┬──┘    └──┬──┘
       │        │          │
       └───┬────┴──────────┘
           ▼
        ┌─────┐
        │  E  │  Grid Integration (Phase 3)
        └──┬──┘
           │
           ▼
        ┌─────┐
        │  F  │  Renderer Integration (Phase 4)
        └─────┘
```

## 2. Contract freeze milestones

Contracts frozen by each epic, unblocking downstream work:

1. **After A spec-freeze** (~Phase 1 week 1): `DecodedImage`, `DecodeError`, `ImageDecoderAdapter` trait, size-cap API frozen. Unblocks B, C, D parsers to start design-ahead.
2. **After A ships** (end Phase 1): Fuzz corpus + panic-free invariant proven. Unblocks actual parser integration.
3. **After B + C + D ship** (end Phase 2): Parse-emit contract frozen (RawImagePayload → ImageEmitted hand-off). Unblocks E.
4. **After E ships** (end Phase 3): Cell-kind + event-envelope frozen in `quanta-proto`. Unblocks F renderer work + RFC 0002 GL follow-up.
5. **After F ships**: Flag can flip from `off` → `stripped-placeholder` default. Full-render flag stays opt-in until dogfood green.

## 3. Parallel execution strategy

### Gear 1 — Implementation trunk

A → (B ‖ C ‖ D) → E → F

The three parser epics (B/C/D) run in parallel because they share only the decoder-adapter trait; they never touch each other's state machines.

### Gear 2 — Cross-cutting — tracks RFC 0001 J + K

- **Telemetry** (§16 of RFC 0003): counters defined in A; instrumentation added with each parser; dashboards in F.
- **CI grep rules**: `check-images-no-decode-in-ui`, `check-images-no-raw-escape-in-grid`, `check-no-image-panic-unwrap` — added in A, enforced from A onward.

### Gear 3 — Design-ahead

- E's cell-kind design doc can start once B/C/D have parse-emit payloads drafted (roughly Phase 2 week 1).
- F's renderer-backend extension can be designed against EPIC-D (RFC 0001) `BackendContract` as soon as B/C/D emit specs settle.

## 4. Phase assignment

Maps to RFC 0003 §17 migration phases (with Phase 0 ADR work treated as "epic pre-work" not a dedicated epic).

| RFC 0003 phase | Epics touched | Notes |
|----------------|---------------|-------|
| Phase 0 (ADRs) | none | ADR 0019/0020/0021 drafted by RFC author |
| Phase 1 (Decoder + fuzz) | A | Must land fuzz-green before Phase 2 |
| Phase 2 (VT engine parsers) | B, C, D | Parallel |
| Phase 3 (Grid + event stream) | E | Sequential after B/C/D |
| Phase 4 (Renderer integration) | F | Unblocks flag-flip experiments |
| Phase 5 (Dogfood + flag default flip) | (operational, not an epic) | Flag flips to `stripped-placeholder` |
| Phase 6 (Flip to `full`) | (operational, not an epic) | Flag flips to `full` once dogfood green for 7 days |

## 5. Ownership map

- **A** — Platform / Core squad (owns crates/ non-UI boundary).
- **B / C / D** — VT Engine squad (parsers live inside `crates/quanta-vt`).
- **E** — Grid/Protocol squad (same squad that owned RFC 0001 EPIC-B + EPIC-C).
- **F** — Renderer / UX squad (same squad that owned RFC 0001 EPIC-D).

Security review (ADR 0020) is a cross-squad checkpoint signed off by Platform Lead before Phase 1 ships.

## 6. Cross-RFC dependencies

- **RFC 0001 EPIC-B** — `quanta-vt::Grid` public API (extended in E).
- **RFC 0001 EPIC-C** — `GridMirror` + protocol types (extended in E).
- **RFC 0001 EPIC-D** — `BackendContract` (extended in F).
- **RFC 0001 EPIC-H** — block overlay behavior around images (collapse/expand preserves anchor).
- **RFC 0002 (WebGL renderer)** — F's renderer extension shipped as a stub; WebGL implementation picked up by RFC 0002 when its backend lands.

## 7. Acceptance roll-up

Each epic carries its own DoD (≥ 15 items). Together they satisfy RFC 0003 §19 acceptance gate. Roll-up mapping:

| RFC 0003 §19 item | Epic that satisfies |
|-------------------|---------------------|
| `timg` renders | B (sixel path) + E + F |
| `imgcat` renders | C (iTerm path) + E + F |
| `chafa` renders | B (sixel path) + E + F |
| `kitten icat` renders | D (kitty path) + E + F |
| `fzf --preview` cycles | F (placement refresh) |
| `image.nvim` works | D + F |
| Zero decode panics (fuzz) | A (primary) + B/C/D (secondary fuzz on parser state) |
| Zero allocations > 64 MB | A |
| Selection/copy across image | E |
| Copy image to clipboard | F |
| Replay of recorded session | E (cache lookup) + F (IndexedDB) |
| Alt-screen scoping | E |
| Resize reflow protocol-correct | E |
| Placeholder on every failure | A (decode) + F (render) |
| CI grep clean | A (rules defined), all epics enforce |
| Telemetry dashboards | all epics instrument |
| Security audit passes | A (primary) + D (kitty filesystem) |
| Performance budgets | A + F |
| Dogfood 7 days P0/P1-free | operational (post-F) |

## 8. Risk register (epic-level)

- **A blocks everything.** If fuzz fails to go panic-free in 2 weeks, B/C/D slip.
- **D is the most complex parser.** Chunked protocol + placement tracker + responses; budget is 2.5 weeks not 2.
- **E has the most cross-squad surface** (RFC 0001 EPIC-B, EPIC-C, EPIC-D all touched). Needs a paired-owner model.
- **F is small but risky** — Canvas `drawImage` has browser-specific quirks (Safari's async decode); plan a per-browser smoke matrix.

## 9. Definition of "done" roll-up

The full RFC 0003 acceptance gate is satisfied when:

- All 6 epics' individual DoDs are ALL-TRUE.
- RFC 0003 §19 acceptance gate is ALL-TRUE.
- Dogfood soak of ≥ 7 days with `experimental.images='full'` in the internal build, zero P0/P1 image-related regressions.
- Security audit sign-off on file-path allowlist + shm denial + size-cap enforcement.
- Public release notes drafted with examples of working programs.

## 10. Epic files

- [`epic-A-image-decoder-crate.md`](./epic-A-image-decoder-crate.md)
- [`epic-B-sixel-protocol.md`](./epic-B-sixel-protocol.md)
- [`epic-C-iterm-inline-images.md`](./epic-C-iterm-inline-images.md)
- [`epic-D-kitty-graphics-protocol.md`](./epic-D-kitty-graphics-protocol.md)
- [`epic-E-grid-integration.md`](./epic-E-grid-integration.md)
- [`epic-F-renderer-integration.md`](./epic-F-renderer-integration.md)

## 11. Hostile-input fuzz suite

A cross-epic invariant maintained across A + B + C + D:

> **For every protocol adapter, a `cargo-fuzz` target must prove: the decoder never panics, never allocates > 64 MB per blob, always terminates in < 100 ms on input ≤ 1 MB.**

Each parser epic (B/C/D) ships its own fuzz target; the decoder epic (A) ships adapter-level fuzz. CI runs a 10-minute fuzz on each target per PR; a nightly 24-hour fuzz runs on all targets and must report zero panics to keep the flag-flip gate green.

Corpus composition:
- real-world outputs from `chafa`, `timg`, `img2sixel`, `imgcat`, `kitten icat`, `jp2a` (when emitting images).
- pathological hand-crafted cases (oversized dims, truncated streams, doubled terminators, nested envelopes).
- AFL-style coverage-guided inputs.
- regression corpus (every bug found adds a permanent corpus entry).
