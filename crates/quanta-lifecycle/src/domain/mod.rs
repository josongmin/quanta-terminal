//! Lifecycle state machine — pure.

use serde::{Deserialize, Serialize};

/// High-level state of the sidecar from the host's perspective. Mirrors the
/// transitions documented in ADR 0004 that the sidecar itself needs to reason
/// about during boot and heartbeat.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    #[default]
    Unstarted,
    Spawning,
    Handshaking,
    Ready,
    Degraded,
    Unresponsive,
    ShuttingDown,
    Stopped,
}

/// Events that drive the handshake phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandshakeEvent {
    SpawnIssued,
    HelloReceived,
    ReadyEmitted,
    IncompatibleEmitted,
    DegradedFlagged,
}

/// Higher-level lifecycle events (heartbeat, shutdown).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleEvent {
    Handshake(HandshakeEvent),
    HeartbeatOk,
    HeartbeatMissed,
    ShutdownRequested,
    StoppedCleanly,
}

impl LifecycleState {
    /// Apply a handshake event. Unknown transitions return the prior state.
    #[must_use]
    pub fn apply_handshake(self, ev: HandshakeEvent) -> Self {
        use HandshakeEvent as H;
        match (self, ev) {
            (LifecycleState::Unstarted, H::SpawnIssued) => LifecycleState::Spawning,
            (LifecycleState::Spawning, H::HelloReceived) => LifecycleState::Handshaking,
            (LifecycleState::Handshaking, H::ReadyEmitted) => LifecycleState::Ready,
            (LifecycleState::Handshaking, H::IncompatibleEmitted) => LifecycleState::Stopped,
            (LifecycleState::Ready | LifecycleState::Degraded, H::DegradedFlagged) => {
                LifecycleState::Degraded
            }
            _ => self,
        }
    }

    /// Apply a generic lifecycle event.
    #[must_use]
    pub fn apply(self, ev: LifecycleEvent) -> Self {
        match ev {
            LifecycleEvent::Handshake(h) => self.apply_handshake(h),
            LifecycleEvent::HeartbeatOk => match self {
                LifecycleState::Unresponsive => LifecycleState::Ready,
                other => other,
            },
            LifecycleEvent::HeartbeatMissed => match self {
                LifecycleState::Ready | LifecycleState::Degraded => LifecycleState::Unresponsive,
                other => other,
            },
            LifecycleEvent::ShutdownRequested => match self {
                LifecycleState::Stopped => LifecycleState::Stopped,
                _ => LifecycleState::ShuttingDown,
            },
            LifecycleEvent::StoppedCleanly => LifecycleState::Stopped,
        }
    }

    /// Terminal means the sidecar has come to rest.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, LifecycleState::Stopped)
    }
}

/// Outcome of a crash-recovery probe performed at sidecar startup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecoveryOutcome {
    /// Clean shutdown marker was present and consumed. No recovery needed.
    CleanStart,
    /// Marker was missing — prior run ended uncleanly. Callers must seal
    /// previously-live blocks to `detached`.
    RecoveredFromCrash,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_happy_path() {
        let s = LifecycleState::default()
            .apply_handshake(HandshakeEvent::SpawnIssued)
            .apply_handshake(HandshakeEvent::HelloReceived)
            .apply_handshake(HandshakeEvent::ReadyEmitted);
        assert_eq!(s, LifecycleState::Ready);
    }

    #[test]
    fn heartbeat_miss_and_recovery() {
        let s = LifecycleState::Ready.apply(LifecycleEvent::HeartbeatMissed);
        assert_eq!(s, LifecycleState::Unresponsive);
        let s = s.apply(LifecycleEvent::HeartbeatOk);
        assert_eq!(s, LifecycleState::Ready);
    }

    #[test]
    fn shutdown_goes_terminal() {
        let s = LifecycleState::Ready
            .apply(LifecycleEvent::ShutdownRequested)
            .apply(LifecycleEvent::StoppedCleanly);
        assert!(s.is_terminal());
    }
}
