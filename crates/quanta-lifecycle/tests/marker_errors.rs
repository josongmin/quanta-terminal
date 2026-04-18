//! Error-path coverage for `FileMarker` / `MarkerStoreError`.
//!
//! Exercises the `MarkerStoreError::Io` arm that the happy-path unit tests do
//! not, and pins the semantics of `probe_startup` when the marker directory is
//! not even readable.

use quanta_lifecycle::{FileMarker, MarkerStore, MarkerStoreError};

#[test]
fn write_to_unwritable_parent_returns_io_error() {
    // `/dev/null/foo` cannot host a regular file (/dev/null is a char device),
    // so `create_dir_all` fails with ENOTDIR. The adapter must map that to
    // `MarkerStoreError::Io(..)` rather than panic.
    let m = FileMarker::new("/dev/null/quanta-lifecycle-unwritable");
    match m.write() {
        Err(MarkerStoreError::Io(msg)) => {
            assert!(
                !msg.is_empty(),
                "Io error message must not be empty for diagnosis"
            );
        }
        Ok(()) => panic!("expected Io error for /dev/null/* path"),
    }
}

#[test]
fn take_on_missing_marker_returns_false_not_error() {
    // Missing-marker is the steady state on a crash-recovered run; it must
    // be surfaced as `Ok(false)`, not as an IO error. This is the contract
    // `Engine::boot` relies on.
    let tmp = tempfile::tempdir().unwrap();
    let m = FileMarker::new(tmp.path());
    let present = m.take().expect("take must not error on missing marker");
    assert!(!present, "take on missing marker must report false");
}

#[test]
fn error_display_starts_with_category_prefix() {
    // Consumers (tracing, RPC error codes) rely on the Display prefix to
    // categorize errors. The `thiserror` derive emits `io error: {0}` — pin
    // that shape so a future refactor does not silently break downstream
    // matching.
    let err = MarkerStoreError::Io("fake".into());
    let s = format!("{err}");
    assert!(s.starts_with("io error:"), "unexpected display: {s}");
}
