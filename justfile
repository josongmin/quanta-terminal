# Quanta Terminal — developer shortcuts.
#
# Every target here has a one-liner CI equivalent in .github/workflows/ci.yml.
# If you add a target, add the matching CI step and the ADR it serves.

# Print available targets. Default when `just` is run bare.
default:
    @just --list

# Run the Tauri host in dev mode. Wires quanta-core → host-tauri → packages/ui.
dev:
    pnpm --filter @quanta/host-tauri dev

# Full test suite: Rust workspace plus every TypeScript package.
test:
    cargo test --workspace --locked
    pnpm -r --if-present test

# Lint everything. Clippy is fail-on-warning to match CI.
lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    pnpm run format:check
    pnpm -r --if-present lint

# Layer enforcement (ADR 0014): hexagonal + FSD. Both must pass.
check-layers:
    cargo run --quiet -p check-hex-imports -- --root .
    node tools/check-fsd-layers.mjs

# Proto schema freshness: compare generated TypeScript under
# packages/ui/src/shared/types/generated against `quanta-proto`. Phase 2
# will wire the actual diff; for now this is a no-op placeholder so the
# target exists and CI can reference it without churn.
proto-check:
    @echo "proto-check: Phase 2 placeholder — schema codegen diff will land with ADR 0012 wiring."

# Build everything. Useful for a cold sanity check before a release tag.
build:
    cargo build --workspace --locked
    pnpm -r build

# Format everything in place. Non-CI; destructive.
fmt:
    cargo fmt --all
    pnpm run format

# Package the `quanta-core` binary into the Tauri bundle layout. Required
# before a production `pnpm tauri build` on a host that hasn't baked the
# binary into PATH. Detects the host triple via `rustc -vV` (ADR 0004).
package-sidecar:
    ./scripts/package-sidecar.sh
