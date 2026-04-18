//! Exhaustive transition coverage for `LifecycleState` (ADR 0004).
//!
//! The state machine is small enough to be enumerated directly. For every
//! `(state, event)` pair we assert either the documented transition target
//! or that the state is preserved (no-op per "unknown transitions return the
//! prior state").

use quanta_lifecycle::{HandshakeEvent as H, LifecycleEvent as E, LifecycleState as S};
use rstest::rstest;

// -- Happy path -----------------------------------------------------------

#[test]
fn happy_path_unstarted_to_ready() {
    let s = S::default();
    assert_eq!(s, S::Unstarted);
    let s = s.apply_handshake(H::SpawnIssued);
    assert_eq!(s, S::Spawning);
    let s = s.apply_handshake(H::HelloReceived);
    assert_eq!(s, S::Handshaking);
    let s = s.apply_handshake(H::ReadyEmitted);
    assert_eq!(s, S::Ready);
}

#[test]
fn handshaking_with_incompatible_goes_stopped() {
    let s = S::Unstarted
        .apply_handshake(H::SpawnIssued)
        .apply_handshake(H::HelloReceived)
        .apply_handshake(H::IncompatibleEmitted);
    assert_eq!(s, S::Stopped);
}

// -- Degraded / Ready oscillation ----------------------------------------

#[test]
fn ready_can_flag_degraded_and_back_via_heartbeat() {
    let s = S::Ready.apply_handshake(H::DegradedFlagged);
    assert_eq!(s, S::Degraded);
    // Degraded -> DegradedFlagged is idempotent.
    let s = s.apply_handshake(H::DegradedFlagged);
    assert_eq!(s, S::Degraded);
    // HeartbeatMissed while Degraded -> Unresponsive.
    let s = s.apply(E::HeartbeatMissed);
    assert_eq!(s, S::Unresponsive);
    // HeartbeatOk from Unresponsive -> Ready.
    let s = s.apply(E::HeartbeatOk);
    assert_eq!(s, S::Ready);
}

// -- Heartbeat transitions ------------------------------------------------

#[rstest]
#[case(S::Ready, S::Unresponsive)]
#[case(S::Degraded, S::Unresponsive)]
#[case(S::Unstarted, S::Unstarted)]
#[case(S::Spawning, S::Spawning)]
#[case(S::Handshaking, S::Handshaking)]
#[case(S::Unresponsive, S::Unresponsive)]
#[case(S::ShuttingDown, S::ShuttingDown)]
#[case(S::Stopped, S::Stopped)]
fn heartbeat_missed_transition_table(#[case] from: S, #[case] to: S) {
    assert_eq!(from.apply(E::HeartbeatMissed), to);
}

#[rstest]
#[case(S::Unresponsive, S::Ready)]
#[case(S::Ready, S::Ready)]
#[case(S::Degraded, S::Degraded)]
#[case(S::Unstarted, S::Unstarted)]
#[case(S::Spawning, S::Spawning)]
#[case(S::Handshaking, S::Handshaking)]
#[case(S::ShuttingDown, S::ShuttingDown)]
#[case(S::Stopped, S::Stopped)]
fn heartbeat_ok_transition_table(#[case] from: S, #[case] to: S) {
    assert_eq!(from.apply(E::HeartbeatOk), to);
}

// -- Shutdown / stop ------------------------------------------------------

#[rstest]
#[case(S::Unstarted)]
#[case(S::Spawning)]
#[case(S::Handshaking)]
#[case(S::Ready)]
#[case(S::Degraded)]
#[case(S::Unresponsive)]
#[case(S::ShuttingDown)]
fn shutdown_requested_transitions_to_shutting_down(#[case] from: S) {
    assert_eq!(from.apply(E::ShutdownRequested), S::ShuttingDown);
}

#[test]
fn shutdown_requested_keeps_stopped_stopped() {
    assert_eq!(S::Stopped.apply(E::ShutdownRequested), S::Stopped);
}

#[rstest]
#[case(S::Unstarted)]
#[case(S::Spawning)]
#[case(S::Handshaking)]
#[case(S::Ready)]
#[case(S::Degraded)]
#[case(S::Unresponsive)]
#[case(S::ShuttingDown)]
#[case(S::Stopped)]
fn stopped_cleanly_always_reaches_stopped(#[case] from: S) {
    assert_eq!(from.apply(E::StoppedCleanly), S::Stopped);
}

// -- Handshake transitions outside of happy path are no-ops --------------

#[rstest]
#[case(S::Unstarted, H::HelloReceived)]
#[case(S::Unstarted, H::ReadyEmitted)]
#[case(S::Spawning, H::SpawnIssued)]
#[case(S::Spawning, H::ReadyEmitted)]
#[case(S::Handshaking, H::SpawnIssued)]
#[case(S::Ready, H::SpawnIssued)]
#[case(S::Stopped, H::SpawnIssued)]
#[case(S::Stopped, H::HelloReceived)]
#[case(S::Stopped, H::ReadyEmitted)]
fn illegal_handshake_events_are_noops(#[case] from: S, #[case] ev: H) {
    assert_eq!(from.apply_handshake(ev), from);
}

// -- is_terminal ----------------------------------------------------------

#[rstest]
#[case(S::Unstarted, false)]
#[case(S::Spawning, false)]
#[case(S::Handshaking, false)]
#[case(S::Ready, false)]
#[case(S::Degraded, false)]
#[case(S::Unresponsive, false)]
#[case(S::ShuttingDown, false)]
#[case(S::Stopped, true)]
fn is_terminal_matrix(#[case] s: S, #[case] terminal: bool) {
    assert_eq!(s.is_terminal(), terminal);
}

// -- Serde roundtrip pins the snake_case wire names ----------------------

#[test]
fn serde_roundtrips_preserve_state() {
    for s in [
        S::Unstarted,
        S::Spawning,
        S::Handshaking,
        S::Ready,
        S::Degraded,
        S::Unresponsive,
        S::ShuttingDown,
        S::Stopped,
    ] {
        let j = serde_json::to_string(&s).expect("serialize");
        let back: S = serde_json::from_str(&j).expect("deserialize");
        assert_eq!(s, back, "roundtrip {s:?}");
    }
}
