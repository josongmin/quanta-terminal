//! Domain types for crash reports.
//!
//! Pure layer: no IO, no async, no clock except via `time::OffsetDateTime`
//! which is a value type. A `CrashReport` is wholly serializable and
//! comparable by hash so tests can pin fingerprint stability without a
//! live reporter.

use serde::{Deserialize, Serialize};

/// A single crash event. Shaped to match what the three major SaaS
/// reporters (Sentry/Bugsnag/Glitchtip) accept at the top level, so a
/// future adapter can mostly pass-through.
///
/// Fields that would leak user data (paths, tokens, argv) live only in
/// `stack` and `message`, and the host-side redactor runs before
/// construction — see `crash::build_report_from_panic` in host-tauri.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashReport {
    /// RFC3339 UTC timestamp, generated at construction time. Stored as
    /// a string so the serialized shape is stable across `time` releases.
    pub timestamp: String,
    /// App semver, e.g. `0.1.0`. Supplied by the caller from
    /// `env!("CARGO_PKG_VERSION")`.
    pub version: String,
    /// Short OS label: `"macos"`, `"linux"`, `"windows"`, `"other"`.
    pub os: String,
    /// Short arch label: `"aarch64"`, `"x86_64"`, `"other"`.
    pub arch: String,
    /// Categorical kind surfaced by the error site. Examples:
    /// `"panic"` (Rust panic), `"unhandled_promise"` (JS unhandled
    /// rejection forwarded via IPC), `"uncaught_error"` (JS sync throw).
    /// Free-form so callers can carry whatever taxonomy they prefer;
    /// `CrashFingerprint` hashes this so a new kind is its own bucket.
    pub error_kind: String,
    /// Human-readable redacted message.
    pub message: String,
    /// Redacted stack trace. `None` when the error site couldn't produce
    /// one (common for JS string rejections).
    pub stack: Option<String>,
    /// A stable fingerprint that identical-shape crashes hash to. Used by
    /// remote reporters for grouping; locally we use it to dedupe the
    /// file sink so a repeatedly-crashing app doesn't fill the disk.
    pub fingerprint: CrashFingerprint,
}

impl CrashReport {
    /// Construct with the current UTC timestamp.
    pub fn new(
        version: impl Into<String>,
        os: impl Into<String>,
        arch: impl Into<String>,
        error_kind: impl Into<String>,
        message: impl Into<String>,
        stack: Option<String>,
    ) -> Self {
        let version = version.into();
        let os = os.into();
        let arch = arch.into();
        let error_kind = error_kind.into();
        let message = message.into();
        let fingerprint = CrashFingerprint::compute(&error_kind, &message, stack.as_deref());
        Self {
            timestamp: now_rfc3339(),
            version,
            os,
            arch,
            error_kind,
            message,
            stack,
            fingerprint,
        }
    }
}

/// 64-bit digest of the stable parts of a crash. Uses a dedicated newtype
/// so equality checks are obvious at the call site (raw `u64` equality is
/// too easy to mis-read). Serialized as a 16-hex-char string for
/// readability in the file-sink JSON output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CrashFingerprint(u64);

impl CrashFingerprint {
    /// Derive a fingerprint from the identifying parts of a crash.
    ///
    /// Hash input choice: `error_kind + normalized message + first-3-frames
    /// of stack (when present)`. The normalizer strips run-specific noise
    /// so two crashes at the same site with different pids/addresses still
    /// collapse to one bucket.
    #[must_use]
    pub fn compute(error_kind: &str, message: &str, stack: Option<&str>) -> Self {
        let normalized_message = normalize_for_fingerprint(message);
        let stack_head = stack
            .map(|s| s.lines().take(3).collect::<Vec<_>>().join("\n"))
            .map(|s| normalize_for_fingerprint(&s))
            .unwrap_or_default();
        let mut hasher = Fnv1a::default();
        hasher.write(error_kind.as_bytes());
        hasher.write(b"|");
        hasher.write(normalized_message.as_bytes());
        hasher.write(b"|");
        hasher.write(stack_head.as_bytes());
        Self(hasher.finish())
    }

    #[must_use]
    pub fn as_hex(self) -> String {
        format!("{:016x}", self.0)
    }
}

impl Serialize for CrashFingerprint {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.as_hex())
    }
}

impl<'de> Deserialize<'de> for CrashFingerprint {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        u64::from_str_radix(&s, 16)
            .map(CrashFingerprint)
            .map_err(serde::de::Error::custom)
    }
}

/// Strip run-specific noise from a fingerprint input. Targets:
///   - hex addresses (`0xdeadbeef` → `0x?`)
///   - digits inside square brackets and after colons (line/col, pids)
///   - trailing whitespace per line
fn normalize_for_fingerprint(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // `0x` hex collapse.
        if i + 1 < bytes.len() && bytes[i] == b'0' && bytes[i + 1] == b'x' {
            out.push_str("0x?");
            i += 2;
            while i < bytes.len() && bytes[i].is_ascii_hexdigit() {
                i += 1;
            }
            continue;
        }
        // Line/column/pid after `:` or `[` — skip digit runs.
        let c = bytes[i] as char;
        if matches!(c, ':' | '[') {
            out.push(c);
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i > start {
                out.push('?');
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Tiny FNV-1a so we don't pull `twox-hash` or `xxhash-rust` into this
/// domain layer (the hex-import checker allows `xxhash-rust` in adapters,
/// not domain). FNV is cryptographically weak but fine for fingerprints:
/// we only need a stable 64-bit hash of small strings.
#[derive(Default)]
struct Fnv1a(u64);

impl Fnv1a {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    fn write(&mut self, bytes: &[u8]) {
        let mut h = if self.0 == 0 { Self::OFFSET } else { self.0 };
        for &b in bytes {
            h ^= u64::from(b);
            h = h.wrapping_mul(Self::PRIME);
        }
        self.0 = h;
    }

    fn finish(self) -> u64 {
        self.0
    }
}

fn now_rfc3339() -> String {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_across_identical_crashes() {
        let a = CrashFingerprint::compute("panic", "division by zero", Some("a::b\nc::d\ne::f"));
        let b = CrashFingerprint::compute("panic", "division by zero", Some("a::b\nc::d\ne::f"));
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_ignores_run_specific_addresses_and_pids() {
        // Same crash site, different pid / address — should still bucket
        // together. Run-specific noise is what normalize_for_fingerprint
        // strips: `0x…`, `[digits]`, `:digits`.
        let a = CrashFingerprint::compute(
            "panic",
            "fault at 0xabcdef12 pid:4242",
            Some("[1234]\nframe a"),
        );
        let b = CrashFingerprint::compute(
            "panic",
            "fault at 0x00112233 pid:9999",
            Some("[5678]\nframe a"),
        );
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_differs_for_different_kinds() {
        let a = CrashFingerprint::compute("panic", "same", None);
        let b = CrashFingerprint::compute("unhandled_promise", "same", None);
        assert_ne!(a, b);
    }

    #[test]
    fn crash_report_round_trips_through_json() {
        let r = CrashReport::new(
            "0.1.0",
            "macos",
            "aarch64",
            "panic",
            "boom",
            Some("a\nb\nc".into()),
        );
        let s = serde_json::to_string(&r).unwrap();
        let parsed: CrashReport = serde_json::from_str(&s).unwrap();
        // `timestamp` is generated at `new` time; round-tripped string is
        // equal. That's the invariant we care about for persistence.
        assert_eq!(r, parsed);
    }
}
