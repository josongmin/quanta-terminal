# Quanta Terminal

Terminal-first, IDE-embedded, PTY-faithful terminal architecture for a Rust core and TypeScript frontend. AI is optional and intentionally non-central.

## Top-Level Documents

- [Product Spec](./docs/product-spec.md)
- [Technical Architecture](./docs/technical-architecture.md)
- [Benchmark Protocol](./docs/benchmark-protocol.md)
- [Terminal Benchmark Matrix](./docs/terminal-benchmark-matrix.md)
- [Warp Benchmark Notes](./docs/warp-benchmark.md)

## Architecture Decision Records

ADRs pin down the parts of the system where implementers would otherwise drift into incompatible interpretations.

- [ADR 0001 — Host Modes and Deployment Targets](./docs/adr/0001-host-modes.md)
- [ADR 0002 — Execution Boundary Contract](./docs/adr/0002-execution-boundary-contract.md)
- [ADR 0003 — Session Metadata Truth Model](./docs/adr/0003-session-metadata-truth-model.md)
- [ADR 0004 — Sidecar Lifecycle Contract](./docs/adr/0004-sidecar-lifecycle-contract.md)
- [ADR 0005 — Storage and Retention](./docs/adr/0005-storage-and-retention.md)
- [ADR 0006 — Secret and Sensitive Data Policy](./docs/adr/0006-secret-and-sensitive-data-policy.md)
- [ADR 0007 — Diagnostic Parser Rollout Plan](./docs/adr/0007-parser-rollout-plan.md)
- [ADR 0008 — Raw / TUI Mode Semantics](./docs/adr/0008-raw-tui-mode-semantics.md)
- [ADR 0009 — Input Routing Operational Policy](./docs/adr/0009-input-routing-policy.md)
- [ADR 0010 — Degraded Mode UI Contract](./docs/adr/0010-degraded-mode-ui-contract.md)
- [ADR 0011 — Event Replay, Reducer Determinism, and Resume](./docs/adr/0011-event-replay-and-reducer-semantics.md)
- [ADR 0012 — Risk Classification Composition Rules](./docs/adr/0012-risk-classification-composition.md)
- [ADR 0013 — History Search and Relevance](./docs/adr/0013-history-search-and-relevance.md)
- [ADR 0014 — Repository Structure (Backend Hexagonal + Frontend FSD)](./docs/adr/0014-repository-structure.md)

## Reading Order

If you are onboarding as an implementation agent:

1. `product-spec.md` — what the product is and why.
2. `technical-architecture.md` — how it is built.
3. ADRs in order — the contracts that keep two implementers from building two different products.
4. [`TESTING.md`](./TESTING.md) — the three test layers (Rust unit / Rust integration over the real socket / vitest + schema parity) and how to run them locally. Start here once you have an environment set up.
5. `benchmark-protocol.md` — how we decide whether it works.

## Testing

See [`TESTING.md`](./TESTING.md). Quick reference:

- `cargo test --workspace` — Rust unit + integration.
- `pnpm -r test` — TypeScript + the Rust-↔-TS schema parity test (`packages/host-common/src/__tests__/schema-parity.test.ts`).
- `cargo run -p check-adr-compliance` — mechanical one-line-per-ADR audit.
- `cargo run -q -p check-hex-imports -- --root .` — hexagonal import rules.
- `node tools/check-fsd-layers.mjs` — FSD layer rules.

## Packaging a production Tauri bundle

End users of the shipped desktop app do not need `quanta-core` on `PATH`; the binary is bundled via Tauri 2's `externalBin` (see `tauri.conf.json`).

```sh
pnpm package-sidecar && pnpm --filter @quanta/host-tauri tauri build
```

Details and the runtime resolver priority (env var → bundled resource → PATH) live in [`TESTING.md`](./TESTING.md#building-a-production-tauri-bundle-with-the-quanta-core-sidecar).
