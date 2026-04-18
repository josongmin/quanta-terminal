//! Strongly-typed identifiers.
//!
//! Every domain noun carries a distinct type. This prevents accidentally passing
//! a `BlockId` where a `SessionId` is expected, and makes call sites self-documenting.
//!
//! Identifiers use ULIDs: monotonic, sortable, and globally unique at generation time.

use serde::{Deserialize, Serialize};
use std::fmt;
use ulid::Ulid;

macro_rules! define_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Ulid);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(Ulid::new())
            }

            #[must_use]
            pub fn from_ulid(ulid: Ulid) -> Self {
                Self(ulid)
            }

            #[must_use]
            pub fn as_ulid(&self) -> Ulid {
                self.0
            }

            #[must_use]
            pub fn as_u128(&self) -> u128 {
                self.0.0
            }

            pub fn parse(s: &str) -> Result<Self, ulid::DecodeError> {
                Ulid::from_string(s).map(Self)
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!($prefix, "({})"), self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl std::str::FromStr for $name {
            type Err = ulid::DecodeError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::parse(s)
            }
        }
    };
}

define_id!(
    /// Identifies a terminal session — one live PTY context with a shell.
    SessionId, "SessionId"
);

define_id!(
    /// Identifies a command block — the unit of structured execution history.
    BlockId, "BlockId"
);

define_id!(
    /// Identifies an output span (contiguous stdout or stderr chunk).
    SpanId, "SpanId"
);

define_id!(
    /// Identifies a diagnostic extracted by a parser adapter.
    DiagnosticId, "DiagnosticId"
);

define_id!(
    /// Identifies an AI-originated command suggestion.
    SuggestionId, "SuggestionId"
);

define_id!(
    /// Identifies a workspace (git remote URL fingerprint or path hash).
    WorkspaceId, "WorkspaceId"
);

define_id!(
    /// Identifies a single event in the append-only log.
    EventId, "EventId"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_distinct_types_but_both_use_ulids() {
        let s = SessionId::new();
        let b = BlockId::new();
        // distinct types — this would not compile: let _: SessionId = b;
        assert_ne!(s.as_u128(), b.as_u128());
    }

    #[test]
    fn roundtrip_through_string() {
        let id = BlockId::new();
        let parsed: BlockId = id.to_string().parse().unwrap();
        assert_eq!(id, parsed);
    }

    #[test]
    fn serde_roundtrip_json() {
        let id = SessionId::new();
        let json = serde_json::to_string(&id).unwrap();
        let back: SessionId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }
}
