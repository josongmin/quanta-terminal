//! Canonical metric-name constants (RFC 0001 §13.14).
//!
//! Every counter / histogram / gauge used by the Quanta sidecar and
//! reducer MUST be referenced through a constant declared here. Two
//! reasons:
//!
//! 1. **Typo safety.** `&'static str` literals in call sites are
//!    silently-successful when misspelled — the recorder happily
//!    allocates a fresh counter for `vt.unknown_cis_count`, nobody
//!    notices. Binding every name to a `pub const` lets the compiler
//!    catch the typo at call time.
//! 2. **Docs live with the name.** The RFC § covering each counter is
//!    linked on the doc comment for the constant, so a reader of the
//!    codebase lands on the authoritative explanation without hunting
//!    through the RFC.
//!
//! The naming convention is the same as the rest of `quanta-metrics`:
//! dotted lowercase, `<subsystem>.<noun>.<verb_or_qualifier>`.
//!
//! # Catalog
//!
//! - `vt.unknown_csi_count` — CSI sequences the VT engine did not
//!   recognise. Per-session label via the recorder's keying scheme
//!   (currently the name alone; labelled names append `.<session>` at
//!   call sites until we have a proper label surface).
//! - `vt.unknown_osc_count` — same, but for OSC.
//! - `vt.width_mismatch_count` — UI mirror's width calculation
//!   diverged from the engine's. Should be zero in steady state.
//! - `vt.full_redraw_frequency` — counter of full-snapshot emissions.
//!   Must trend to zero outside connect / resume / resize. The rolling-
//!   rate helper on the recorder derives a per-minute rate from it.
//! - `vt.delta_size_bytes` — histogram of `GridDelta` payload sizes.
//! - `vt.out_of_order_events_dropped` — reducer fenced an event whose
//!   `(grid_epoch, sequence_no)` fell behind the last-applied pair.
//! - `vt.stale_epoch_events_dropped` — reducer dropped an event whose
//!   `grid_epoch` is older than the current epoch.
//! - `vt.row_resync_requests` — UI asked the engine for a row resync
//!   after detecting mirror divergence.
//! - `vt.full_snapshot_fallbacks` — engine emitted a full snapshot
//!   because delta-only resync was not possible.
//! - `vt.mode_negotiation_conflicts` — mode-state reducer observed a
//!   contradictory mode message (e.g. request to enable alt-screen
//!   while a pending disable is in flight).
//! - `ime.lifecycle_start` / `ime.lifecycle_commit` /
//!   `ime.lifecycle_cancel` — IME composition lifecycle counters.
//!   Tracked per-session; useful for detecting stuck preedit in the
//!   wild.
//! - `ime.abnormal_termination` — IME composition ended through any
//!   path other than `commit` / `cancel` (focus-lost mid-preedit,
//!   tab-away, blur without explicit cancellation).
//! - `ui.selection_normalization_corrections` — histogram of
//!   per-selection correction deltas (cells). Non-zero values mean the
//!   UI cache drifted from canonical normalization.
//! - `renderer.backend_recovery_events` — renderer backend re-init
//!   (atlas rebuild, context restore). Non-zero indicates GPU / font
//!   instability.
//!
//! The list MUST be kept in sync with RFC 0001 §13.14. Adding a new
//! counter? Add it here first, then reference it at the call site.

/// Counter: VT engine saw a CSI sequence it did not recognise.
///
/// Incremented once per unknown CSI dispatch. Per RFC §13.14, consumers
/// may append a session-id suffix in the future; for now the bare name
/// is used.
pub const VT_UNKNOWN_CSI_COUNT: &str = "vt.unknown_csi_count";

/// Counter: VT engine saw an OSC payload whose code was unrecognised.
pub const VT_UNKNOWN_OSC_COUNT: &str = "vt.unknown_osc_count";

/// Counter: UI mirror's width calculation disagreed with the engine's.
pub const VT_WIDTH_MISMATCH_COUNT: &str = "vt.width_mismatch_count";

/// Counter: full-snapshot emissions (connect / resume / resize /
/// forced resync). Outside those paths, trending > 0 indicates the
/// steady-state delta path is breaking.
pub const VT_FULL_REDRAW_FREQUENCY: &str = "vt.full_redraw_frequency";

/// Histogram: `GridDelta` payload size in bytes.
pub const VT_DELTA_SIZE_BYTES: &str = "vt.delta_size_bytes";

/// Counter: reducer dropped an event because its `sequence_no` was
/// behind the last-applied.
pub const VT_OUT_OF_ORDER_EVENTS_DROPPED: &str = "vt.out_of_order_events_dropped";

/// Counter: reducer dropped an event because its `grid_epoch` is
/// older than the current epoch (post-resize / post-reset fence).
pub const VT_STALE_EPOCH_EVENTS_DROPPED: &str = "vt.stale_epoch_events_dropped";

/// Counter: UI requested a row-range resync after mirror divergence.
pub const VT_ROW_RESYNC_REQUESTS: &str = "vt.row_resync_requests";

/// Counter: engine emitted a full `GridSnapshot` because targeted
/// delta resync was not possible.
pub const VT_FULL_SNAPSHOT_FALLBACKS: &str = "vt.full_snapshot_fallbacks";

/// Counter: mode-state reducer observed contradictory mode changes.
pub const VT_MODE_NEGOTIATION_CONFLICTS: &str = "vt.mode_negotiation_conflicts";

/// Counter: IME composition started.
pub const IME_LIFECYCLE_START: &str = "ime.lifecycle_start";

/// Counter: IME composition committed (grid received bytes).
pub const IME_LIFECYCLE_COMMIT: &str = "ime.lifecycle_commit";

/// Counter: IME composition cancelled (user or system).
pub const IME_LIFECYCLE_CANCEL: &str = "ime.lifecycle_cancel";

/// Counter: IME composition terminated abnormally (blur / tab-switch
/// / focus loss mid-preedit without explicit cancel).
pub const IME_ABNORMAL_TERMINATION: &str = "ime.abnormal_termination";

/// Histogram: selection-normalization correction amount (cells). Zero
/// values mean the UI cache matched canonical; non-zero means a
/// correction was applied.
pub const UI_SELECTION_NORMALIZATION_CORRECTIONS: &str = "ui.selection_normalization_corrections";

/// Counter: renderer backend recovery event (context restore / atlas
/// rebuild / GPU fallback).
pub const RENDERER_BACKEND_RECOVERY_EVENTS: &str = "renderer.backend_recovery_events";

/// Every metric name declared in this module. Exposed for tests and
/// for the recorder's full-snapshot sanity check.
///
/// Ordered roughly by subsystem so a snapshot reads top-down from
/// `vt.*` → `ime.*` → `ui.*` → `renderer.*`. The recorder sorts
/// alphabetically on output, so this order only affects the constant
/// array itself.
pub const ALL_METRIC_NAMES: &[&str] = &[
    VT_UNKNOWN_CSI_COUNT,
    VT_UNKNOWN_OSC_COUNT,
    VT_WIDTH_MISMATCH_COUNT,
    VT_FULL_REDRAW_FREQUENCY,
    VT_DELTA_SIZE_BYTES,
    VT_OUT_OF_ORDER_EVENTS_DROPPED,
    VT_STALE_EPOCH_EVENTS_DROPPED,
    VT_ROW_RESYNC_REQUESTS,
    VT_FULL_SNAPSHOT_FALLBACKS,
    VT_MODE_NEGOTIATION_CONFLICTS,
    IME_LIFECYCLE_START,
    IME_LIFECYCLE_COMMIT,
    IME_LIFECYCLE_CANCEL,
    IME_ABNORMAL_TERMINATION,
    UI_SELECTION_NORMALIZATION_CORRECTIONS,
    RENDERER_BACKEND_RECOVERY_EVENTS,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_metric_names_are_unique() {
        let mut sorted: Vec<&str> = ALL_METRIC_NAMES.to_vec();
        sorted.sort_unstable();
        let n = sorted.len();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            n,
            "ALL_METRIC_NAMES must not contain duplicates"
        );
    }

    #[test]
    fn every_name_uses_dotted_lowercase() {
        for name in ALL_METRIC_NAMES {
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c == '.' || c == '_' || c.is_ascii_digit()),
                "metric name `{name}` must be dotted-lowercase with underscores only"
            );
            assert!(name.contains('.'), "metric `{name}` lacks subsystem prefix");
        }
    }

    #[test]
    fn rfc_subsystems_are_represented() {
        // Sanity check: every required subsystem from RFC §13.14
        // appears somewhere in the list. If a subsystem disappears,
        // this catches it before CI does.
        let joined = ALL_METRIC_NAMES.join("|");
        for subsystem in ["vt.", "ime.", "ui.", "renderer."] {
            assert!(
                joined.contains(subsystem),
                "subsystem `{subsystem}` missing from metric name catalog"
            );
        }
    }
}
