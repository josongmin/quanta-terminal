//! Canonical registry of Tauri / IPC event topic names.
//!
//! Every `quanta://*` topic emitted by the host to the UI lives here. The
//! `check-event-topic-names` CI tool enumerates every `quanta://*` string
//! literal in the workspace and asserts each one appears in this table —
//! adding a new topic without registering it fails CI.
//!
//! # Why a registry?
//!
//! Topic strings spread across host-tauri, UI code, docs, and fixtures. A
//! typo in any one place silently breaks routing (the listener registers
//! against a name that is never emitted). The registry turns the set of
//! valid names into a single-source-of-truth constant: anything not here
//! is a bug.
//!
//! Topics MUST use hyphens in path segments, not dots: Tauri 2 warns on
//! `.` in event names (ADR-documented in `packages/host-tauri/README.md`).

/// Every topic the host emits or the UI listens to. When adding a new
/// topic, append the literal here AND document the payload shape in
/// `packages/host-tauri/README.md`. The CI lint will flag any unregistered
/// `quanta://*` literal anywhere in the workspace.
pub const REGISTERED_TOPICS: &[&str] = &[
    "quanta://pty-data",
    "quanta://pty-exit",
    "quanta://session-created",
    "quanta://session-cwd-changed",
    "quanta://session-shell-integration-status",
    "quanta://diagnostic-detected",
    "quanta://sidecar-recovered",
];

/// Compile-time sanity: every entry starts with the `quanta://` scheme.
const _: () = {
    let mut i = 0;
    while i < REGISTERED_TOPICS.len() {
        let t = REGISTERED_TOPICS[i].as_bytes();
        assert!(
            t.len() >= 9
                && t[0] == b'q'
                && t[1] == b'u'
                && t[2] == b'a'
                && t[3] == b'n'
                && t[4] == b't'
                && t[5] == b'a'
                && t[6] == b':'
                && t[7] == b'/'
                && t[8] == b'/',
            "registered topic must start with quanta://",
        );
        i += 1;
    }
};

/// Whether `topic` is a registered IPC topic.
#[must_use]
pub fn is_registered(topic: &str) -> bool {
    REGISTERED_TOPICS.contains(&topic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_the_baseline_topics() {
        // Pin the phase-1 baseline — these cannot quietly disappear from
        // the table without a deliberate code review.
        for expected in [
            "quanta://pty-data",
            "quanta://pty-exit",
            "quanta://session-created",
            "quanta://session-cwd-changed",
            "quanta://session-shell-integration-status",
            "quanta://diagnostic-detected",
            "quanta://sidecar-recovered",
        ] {
            assert!(is_registered(expected), "{expected} not in registry");
        }
    }

    #[test]
    fn is_registered_rejects_unknown_topics() {
        assert!(!is_registered("quanta://fictional"));
        assert!(!is_registered("not-a-topic"));
    }

    #[test]
    fn every_entry_uses_hyphens_not_dots_in_path_segments() {
        for t in REGISTERED_TOPICS {
            let path = t.strip_prefix("quanta://").unwrap_or(t);
            assert!(
                !path.contains('.'),
                "topic {t} uses `.`; Tauri 2 warns on dots — use hyphens"
            );
        }
    }
}
