//! Integration test: every RFC 0001 §13.14 counter can be recorded
//! through the public API and surfaces in the snapshot.
//!
//! This is a structural check — it does not care about the value.
//! A regression where a counter name changes without updating the
//! `names` constant is what this test exists to catch.

use quanta_metrics::names::{
    ALL_METRIC_NAMES, IME_ABNORMAL_TERMINATION, IME_LIFECYCLE_CANCEL, IME_LIFECYCLE_COMMIT,
    IME_LIFECYCLE_START, RENDERER_BACKEND_RECOVERY_EVENTS, UI_SELECTION_NORMALIZATION_CORRECTIONS,
    VT_DELTA_SIZE_BYTES, VT_FULL_REDRAW_FREQUENCY, VT_FULL_SNAPSHOT_FALLBACKS,
    VT_MODE_NEGOTIATION_CONFLICTS, VT_OUT_OF_ORDER_EVENTS_DROPPED, VT_ROW_RESYNC_REQUESTS,
    VT_STALE_EPOCH_EVENTS_DROPPED, VT_UNKNOWN_CSI_COUNT, VT_UNKNOWN_OSC_COUNT,
    VT_WIDTH_MISMATCH_COUNT,
};
use quanta_metrics::{InMemoryRecorder, MetricsRecorder};

/// Bind the RFC list here so the test fails if the named constants
/// drift from the public catalog. Each entry is split into (counter
/// names, histogram names) so we exercise the correct record method
/// per metric.
fn counter_names() -> &'static [&'static str] {
    &[
        VT_UNKNOWN_CSI_COUNT,
        VT_UNKNOWN_OSC_COUNT,
        VT_WIDTH_MISMATCH_COUNT,
        VT_FULL_REDRAW_FREQUENCY,
        VT_OUT_OF_ORDER_EVENTS_DROPPED,
        VT_STALE_EPOCH_EVENTS_DROPPED,
        VT_ROW_RESYNC_REQUESTS,
        VT_FULL_SNAPSHOT_FALLBACKS,
        VT_MODE_NEGOTIATION_CONFLICTS,
        IME_LIFECYCLE_START,
        IME_LIFECYCLE_COMMIT,
        IME_LIFECYCLE_CANCEL,
        IME_ABNORMAL_TERMINATION,
        RENDERER_BACKEND_RECOVERY_EVENTS,
    ]
}

fn histogram_names() -> &'static [&'static str] {
    &[VT_DELTA_SIZE_BYTES, UI_SELECTION_NORMALIZATION_CORRECTIONS]
}

#[test]
fn every_counter_in_catalog_round_trips_through_snapshot() {
    let r = InMemoryRecorder::new();
    for name in counter_names() {
        r.inc_counter(name);
    }
    for name in histogram_names() {
        r.record_histogram(name, 42);
    }

    let snap = r.snapshot();
    for name in counter_names() {
        let found = snap
            .counters
            .iter()
            .any(|(k, v)| k == *name && v.value == 1);
        assert!(found, "counter `{name}` missing from snapshot");
    }
    for name in histogram_names() {
        let found = snap
            .histograms
            .iter()
            .any(|(k, v)| k == *name && v.count == 1 && v.sum == 42);
        assert!(found, "histogram `{name}` missing from snapshot");
    }
}

#[test]
fn all_metric_names_matches_the_union_of_counter_and_histogram_lists() {
    let mut expected: Vec<&'static str> = counter_names().iter().copied().collect();
    expected.extend(histogram_names().iter().copied());
    expected.sort_unstable();

    let mut actual: Vec<&'static str> = ALL_METRIC_NAMES.iter().copied().collect();
    actual.sort_unstable();

    assert_eq!(
        actual, expected,
        "names::ALL_METRIC_NAMES must equal counters ∪ histograms"
    );
}

#[test]
fn dump_snapshot_json_shape_is_stable() {
    let r = InMemoryRecorder::new();
    r.inc_counter(VT_UNKNOWN_CSI_COUNT);
    r.record_histogram(VT_DELTA_SIZE_BYTES, 1024);
    let value = r.dump_snapshot();
    assert!(value.is_object(), "snapshot root must be object");
    let obj = value.as_object().unwrap();
    for key in ["counters", "gauges", "histograms"] {
        assert!(obj.contains_key(key), "missing key `{key}`");
    }
}
