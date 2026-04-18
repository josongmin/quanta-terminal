//! Per-event-type schema versioning.
//!
//! Per [ADR 0011], every event carries a `schema_version`. A reducer that does not
//! understand a version must refuse to reduce rather than silently upgrade.
//!
//! When adding a new field to an event payload, bump the version and document the
//! migration path.

use serde::{Deserialize, Serialize};

/// A version tag for a single event type's payload schema.
///
/// Numbers are monotonic and per-event-type, not global.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Debug)]
#[serde(transparent)]
pub struct SchemaVersion(pub u32);

impl SchemaVersion {
    pub const ONE: SchemaVersion = SchemaVersion(1);

    #[must_use]
    pub const fn new(v: u32) -> Self {
        Self(v)
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

impl Default for SchemaVersion {
    fn default() -> Self {
        Self::ONE
    }
}
