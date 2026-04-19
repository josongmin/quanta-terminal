//! `quanta-replay-cli` — a user-facing CLI tool for replaying events from a
//! profile directory outside the running sidecar.
//!
//! Per the Round-10 audit (item 11): dumping the event log as JSON from a
//! profile directory is a common debug workflow (support tickets, post-mortem
//! of a crashed session) that previously required in-process tooling. This
//! crate exposes a small binary plus a library so the integration tests can
//! drive the replay without spawning a subprocess.
//!
//! The crate ONLY reads the existing `quanta-events` public reader API
//! (`ZstdSegmentedEventLog::new` + `EventLogReader::replay_all` /
//! `replay_session`); it does not modify any upstream crate.

use std::io::Write;
use std::path::PathBuf;

use quanta_events::{EventLogReader, LogRecord, ZstdSegmentedEventLog};
use quanta_proto::ids::SessionId;
use serde::Serialize;
use thiserror::Error;

/// Output format selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    /// One JSON object per line (default — easy to pipe into `jq`).
    Ndjson,
    /// Pretty-printed JSON with a two-space indent. One record per pretty
    /// block separated by a blank line.
    Pretty,
}

impl OutputFormat {
    pub fn parse(s: &str) -> Result<Self, ReplayCliError> {
        match s {
            "ndjson" => Ok(Self::Ndjson),
            "pretty" => Ok(Self::Pretty),
            other => Err(ReplayCliError::BadFormat(other.to_string())),
        }
    }
}

/// Replay options — produced by `Options::parse_argv` or constructed directly
/// by the integration tests.
#[derive(Debug, Clone)]
pub struct Options {
    pub profile_dir: PathBuf,
    pub session_id: Option<SessionId>,
    pub until_seq: Option<u64>,
    pub format: OutputFormat,
    /// Optional kind filter — e.g. `--filter-kind block_created` passes only
    /// `Event::BlockCreated` records through. Matched against the lowercased
    /// snake_case tag used in the serialized envelope.
    pub filter_kind: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            profile_dir: PathBuf::new(),
            session_id: None,
            until_seq: None,
            format: OutputFormat::Ndjson,
            filter_kind: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum ReplayCliError {
    #[error("missing --profile-dir")]
    MissingProfileDir,
    #[error("unknown flag: {0}")]
    UnknownFlag(String),
    #[error("missing value for {0}")]
    MissingValue(&'static str),
    #[error("bad --format {0}; expected ndjson|pretty")]
    BadFormat(String),
    #[error("bad session id: {0}")]
    BadSessionId(String),
    #[error("bad --until-seq: {0}")]
    BadSeq(String),
    #[error("event log open/replay: {0}")]
    Replay(String),
    #[error("serialize: {0}")]
    Serialize(String),
    #[error("io: {0}")]
    Io(String),
}

impl Options {
    /// Minimal argv parser — kept in-house instead of pulling `clap` just so
    /// the binary stays small. The flag shapes mirror the audit spec:
    ///
    ///   `quanta-replay --profile-dir <PATH> [--session-id <ID>]
    ///                  [--until-seq N] [--format pretty|ndjson]
    ///                  [--filter-kind <event_kind>]`
    pub fn parse_argv(argv: &[String]) -> Result<Self, ReplayCliError> {
        let mut opts = Options::default();
        let mut iter = argv.iter();
        // `argv[0]` is the binary name when called from a real process; skip
        // it only if it doesn't look like a flag.
        if let Some(first) = argv.first() {
            if !first.starts_with("--") {
                iter.next();
            }
        }
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--profile-dir" => {
                    let v = iter
                        .next()
                        .ok_or(ReplayCliError::MissingValue("--profile-dir"))?;
                    opts.profile_dir = PathBuf::from(v);
                }
                "--session-id" => {
                    let v = iter
                        .next()
                        .ok_or(ReplayCliError::MissingValue("--session-id"))?;
                    opts.session_id = Some(
                        SessionId::parse(v).map_err(|_| ReplayCliError::BadSessionId(v.clone()))?,
                    );
                }
                "--until-seq" => {
                    let v = iter
                        .next()
                        .ok_or(ReplayCliError::MissingValue("--until-seq"))?;
                    opts.until_seq = Some(
                        v.parse::<u64>()
                            .map_err(|e| ReplayCliError::BadSeq(e.to_string()))?,
                    );
                }
                "--format" => {
                    let v = iter
                        .next()
                        .ok_or(ReplayCliError::MissingValue("--format"))?;
                    opts.format = OutputFormat::parse(v)?;
                }
                "--filter-kind" => {
                    let v = iter
                        .next()
                        .ok_or(ReplayCliError::MissingValue("--filter-kind"))?;
                    opts.filter_kind = Some(v.clone());
                }
                other => return Err(ReplayCliError::UnknownFlag(other.to_string())),
            }
        }
        if opts.profile_dir.as_os_str().is_empty() {
            return Err(ReplayCliError::MissingProfileDir);
        }
        Ok(opts)
    }
}

/// The shape each record gets serialized into on stdout. Flatter than the
/// full `LogRecord` so JSON tooling has ergonomic keys (`session_id`, `seq`,
/// `kind`, `event`). The full envelope still rides along under `envelope` so
/// consumers that want every field can still get at it.
#[derive(Debug, Serialize)]
struct ReplayLine<'a> {
    session_id: String,
    seq: u64,
    kind: String,
    envelope: &'a quanta_proto::envelope::Envelope<quanta_proto::events::Event>,
}

/// Extract the snake_case tag for a known event, or the unknown-tag string.
fn event_kind_tag(ev: &quanta_proto::events::Event) -> String {
    use quanta_proto::events::Event;
    match ev {
        Event::SessionCreated(_) => "session_created",
        Event::SessionShellIntegrationStatus(_) => "session_shell_integration_status",
        Event::SessionCwdChanged(_) => "session_cwd_changed",
        Event::SessionEnded(_) => "session_ended",
        Event::BlockCreated(_) => "block_created",
        Event::BlockStarted(_) => "block_started",
        Event::BlockCompleted(_) => "block_completed",
        Event::BlockCanceled(_) => "block_canceled",
        Event::BlockDetached(_) => "block_detached",
        Event::BlockTuiEntered(_) => "block_tui_entered",
        Event::BlockTuiExited(_) => "block_tui_exited",
        Event::OutputChunk(_) => "output_chunk",
        Event::OutputTruncated(_) => "output_truncated",
        Event::InputSubmitted(_) => "input_submitted",
        Event::DiagnosticDetected(_) => "diagnostic_detected",
        Event::SuggestionGenerated(_) => "suggestion_generated",
        Event::SuggestionReviewed(_) => "suggestion_reviewed",
        Event::HistoryIndexed(_) => "history_indexed",
        Event::Unknown { kind, .. } => return kind.clone(),
    }
    .to_string()
}

/// Async replay entry — loads the reader, fetches records, applies filters,
/// then writes out to `out`. Kept separate from `run_sync` so integration tests
/// can drive the replay in their own tokio runtime.
pub async fn replay<W: Write>(opts: &Options, out: &mut W) -> Result<(), ReplayCliError> {
    // The reader validates the root path itself; we don't pre-check existence
    // because `ZstdSegmentedEventLog::new` will `create_dir_all` and then
    // produce an empty replay — useful when the caller points at a fresh
    // profile.
    let reader = ZstdSegmentedEventLog::new(&opts.profile_dir)
        .map_err(|e| ReplayCliError::Replay(e.to_string()))?;
    let records: Vec<LogRecord> = match opts.session_id {
        Some(sid) => reader
            .replay_session(sid)
            .await
            .map_err(|e| ReplayCliError::Replay(e.to_string()))?,
        None => reader
            .replay_all()
            .await
            .map_err(|e| ReplayCliError::Replay(e.to_string()))?,
    };

    let filter = opts.filter_kind.as_deref();
    let until_seq = opts.until_seq;

    for rec in &records {
        if let Some(stop) = until_seq {
            if rec.envelope.monotonic_seq > stop {
                break;
            }
        }
        let kind = event_kind_tag(&rec.envelope.payload);
        if let Some(want) = filter {
            if kind != want {
                continue;
            }
        }
        let line = ReplayLine {
            session_id: rec.envelope.session_id.to_string(),
            seq: rec.envelope.monotonic_seq,
            kind,
            envelope: &rec.envelope,
        };
        match opts.format {
            OutputFormat::Ndjson => {
                let s = serde_json::to_string(&line)
                    .map_err(|e| ReplayCliError::Serialize(e.to_string()))?;
                writeln!(out, "{s}").map_err(|e| ReplayCliError::Io(e.to_string()))?;
            }
            OutputFormat::Pretty => {
                let s = serde_json::to_string_pretty(&line)
                    .map_err(|e| ReplayCliError::Serialize(e.to_string()))?;
                writeln!(out, "{s}\n").map_err(|e| ReplayCliError::Io(e.to_string()))?;
            }
        }
    }
    Ok(())
}

/// Sync entry — wraps `replay` in a current-thread runtime so `main` stays
/// simple and tests that don't want `#[tokio::test]` can still drive it.
pub fn run_sync<W: Write>(opts: &Options, out: &mut W) -> Result<(), ReplayCliError> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| ReplayCliError::Io(e.to_string()))?;
    rt.block_on(replay(opts, out))
}

/// Help text printed when the user passes `--help` or provides no args.
pub const HELP_TEXT: &str = "\
quanta-replay — dump the event log from a profile directory as JSON.

USAGE:
    quanta-replay --profile-dir <PATH> [OPTIONS]

OPTIONS:
    --profile-dir <PATH>      Profile directory (same as QUANTA_PROFILE_DIR)
    --session-id <ID>         Only replay events from this session
    --until-seq <N>           Stop after records with monotonic_seq <= N
    --format <pretty|ndjson>  Output format (default: ndjson)
    --filter-kind <KIND>      Only print events whose kind matches (snake_case)
    -h, --help                Show this help
";

/// True if argv contains a help flag; lets `main` short-circuit to printing
/// help before the stricter argv parser complains about missing flags.
pub fn argv_requests_help(argv: &[String]) -> bool {
    argv.iter().any(|a| a == "-h" || a == "--help")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_argv_rejects_missing_profile_dir() {
        let err = Options::parse_argv(&["bin".into()]).unwrap_err();
        matches!(err, ReplayCliError::MissingProfileDir);
    }

    #[test]
    fn parse_argv_accepts_minimum_flags() {
        let argv = [
            "quanta-replay".to_string(),
            "--profile-dir".into(),
            "/tmp/x".into(),
        ];
        let o = Options::parse_argv(&argv).unwrap();
        assert_eq!(o.profile_dir, PathBuf::from("/tmp/x"));
        assert!(o.session_id.is_none());
        assert_eq!(o.format, OutputFormat::Ndjson);
    }

    #[test]
    fn parse_argv_accepts_all_flags() {
        let sid = SessionId::new().to_string();
        let argv = [
            "bin".into(),
            "--profile-dir".into(),
            "/tmp/x".into(),
            "--session-id".into(),
            sid.clone(),
            "--until-seq".into(),
            "42".into(),
            "--format".into(),
            "pretty".into(),
            "--filter-kind".into(),
            "block_created".into(),
        ];
        let o = Options::parse_argv(&argv).unwrap();
        assert_eq!(o.until_seq, Some(42));
        assert_eq!(o.format, OutputFormat::Pretty);
        assert_eq!(o.filter_kind.as_deref(), Some("block_created"));
        assert!(o.session_id.is_some());
    }

    #[test]
    fn bad_format_rejected() {
        let err = OutputFormat::parse("xml").unwrap_err();
        matches!(err, ReplayCliError::BadFormat(_));
    }

    #[test]
    fn help_flag_detected() {
        assert!(argv_requests_help(&["bin".into(), "--help".into()]));
        assert!(argv_requests_help(&["bin".into(), "-h".into()]));
        assert!(!argv_requests_help(&["bin".into()]));
    }
}
