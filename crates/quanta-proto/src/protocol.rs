//! Sidecar / host handshake messages.
//!
//! Per [ADR 0004], the host and sidecar exchange a handshake on connect.
//! If versions mismatch, the sidecar replies `Incompatible` and the host surfaces
//! an upgrade prompt. No silent fallback.

use serde::{Deserialize, Serialize};

/// A protocol version is a monotonic integer plus a supported range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolVersion {
    pub version: u32,
    pub min_supported: u32,
}

impl ProtocolVersion {
    pub const CURRENT: ProtocolVersion = ProtocolVersion {
        version: 1,
        min_supported: 1,
    };

    #[must_use]
    pub fn is_compatible_with(self, other: ProtocolVersion) -> bool {
        // Either side's `min_supported` must be <= the other's `version`.
        self.min_supported <= other.version && other.min_supported <= self.version
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hello {
    pub host_protocol_version: ProtocolVersion,
    pub host_version: String,
    pub client_id: String,
    /// Per ADR 0011 §Resume Cursor: a reconnecting host may ask the sidecar to
    /// replay events for specific sessions starting from the last seq the host
    /// durably applied. Empty (or missing) = cold start, no replay requested.
    /// Keyed by session id ULID string for stable JSON shape.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub resume_cursors: std::collections::HashMap<String, u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ready {
    pub core_protocol_version: ProtocolVersion,
    pub core_version: String,
    pub sidecar_id: String,
    pub session_recovery_available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Incompatible {
    pub reason: String,
    pub core_protocol_version: ProtocolVersion,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatibility_is_symmetric_at_equal_versions() {
        let v = ProtocolVersion::CURRENT;
        assert!(v.is_compatible_with(v));
    }

    #[test]
    fn newer_host_older_core_compatible_when_core_still_supports() {
        let host = ProtocolVersion {
            version: 2,
            min_supported: 1,
        };
        let core = ProtocolVersion {
            version: 1,
            min_supported: 1,
        };
        assert!(host.is_compatible_with(core));
    }

    #[test]
    fn incompatible_when_core_min_above_host_version() {
        let host = ProtocolVersion {
            version: 1,
            min_supported: 1,
        };
        let core = ProtocolVersion {
            version: 3,
            min_supported: 3,
        };
        assert!(!host.is_compatible_with(core));
    }
}
