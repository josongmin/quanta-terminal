//! `quanta-integration-tests` — workspace-spanning integration harness.
//!
//! The library target exists only so Cargo has a build unit. All real content
//! lives under `tests/` as integration-test binaries; each file in that
//! directory becomes its own `cargo test` target.
//!
//! Entry points:
//!   - `tests/end_to_end.rs` — drives the real binary over its Unix socket.
//!   - `tests/common/mod.rs` — shared client helpers (spawn, handshake, RPC).
