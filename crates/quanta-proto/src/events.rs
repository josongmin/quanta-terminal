//! Typed event union.
//!
//! This enum is the payload for `Envelope<Event>`. Event types map one-to-one to
//! the domain actions they describe. Payloads are flat for easy serde handling
//! and versioned via the envelope's `schema_version`.
//!
//! Per [ADR 0014], event types use the domain name as prefix (`session.*`, `block.*`,
//! etc.), and the `Producer` on the envelope agrees with the prefix.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::ids::{BlockId, DiagnosticId, SessionId, SpanId, SuggestionId, WorkspaceId};

/// The complete union of event payloads.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    // --- session ---
    SessionCreated(SessionCreated),
    SessionShellIntegrationStatus(SessionShellIntegrationStatus),
    SessionCwdChanged(SessionCwdChanged),
    SessionEnded(SessionEnded),

    // --- block ---
    BlockCreated(BlockCreated),
    BlockStarted(BlockStarted),
    BlockCompleted(BlockCompleted),
    BlockCanceled(BlockCanceled),
    BlockDetached(BlockDetached),
    BlockTuiEntered(BlockTuiEntered),
    BlockTuiExited(BlockTuiExited),

    // --- output ---
    OutputChunk(OutputChunk),
    OutputTruncated(OutputTruncated),

    // --- input ---
    InputSubmitted(InputSubmitted),

    // --- diagnostic ---
    DiagnosticDetected(DiagnosticDetected),

    // --- suggestion ---
    SuggestionGenerated(SuggestionGenerated),
    SuggestionReviewed(SuggestionReviewed),

    // --- history ---
    HistoryIndexed(HistoryIndexed),
}

// --- session payloads ---

/// Payload for [`Event::SessionCreated`]: a new session has been minted.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionCreated {
    pub session_id: SessionId,
    pub workspace_id: Option<WorkspaceId>,
    pub shell: String,
    pub launch_cwd: PathBuf,
}

/// Tiered health of the host shell's integration with Quanta.
///
/// Drives the `session.shell_integration_status` event and — downstream — the
/// degraded-mode UI contract (ADR 0010).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellIntegrationStatus {
    Installed,
    Missing,
    Partial,
}

/// Payload for [`Event::SessionShellIntegrationStatus`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionShellIntegrationStatus {
    pub status: ShellIntegrationStatus,
}

/// Where a cwd observation came from (ADR 0003).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CwdSource {
    Launch,
    Osc7,
    PromptEstimate,
    Unknown,
    ExplicitOverride,
}

/// Payload for [`Event::SessionCwdChanged`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionCwdChanged {
    pub cwd: PathBuf,
    pub source: CwdSource,
}

/// Payload for [`Event::SessionEnded`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionEnded {
    pub reason: SessionEndReason,
}

/// Why a session ended (ADR 0004).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEndReason {
    ShellExited,
    UserClosed,
    SidecarShutdown,
    Crash,
}

// --- block payloads ---

/// Coarse-grain classification of a block (ADR 0002).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Command,
    TuiSession,
    Detached,
}

/// Which signal closed a block boundary (ADR 0002).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoundarySignal {
    Osc133,
    ChildExit,
    PromptRegex,
}

/// How confident we are in the boundary assignment (ADR 0002, ADR 0010).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoundaryConfidence {
    Authoritative,
    Degraded,
}

/// Payload for [`Event::BlockCreated`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockCreated {
    pub block_id: BlockId,
    pub ordinal: u64,
    pub input_text: String,
    pub input_kind: InputKind,
    pub cwd: PathBuf,
    pub cwd_source: CwdSource,
    pub is_compound: bool,
}

/// Whether an input was typed as a shell command or an AI intent (ADR 0009).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputKind {
    Shell,
    Intent,
}

/// Payload for [`Event::BlockStarted`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockStarted {
    pub block_id: BlockId,
    pub pid: Option<u32>,
}

/// Payload for [`Event::BlockCompleted`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockCompleted {
    pub block_id: BlockId,
    pub exit_code: Option<i32>,
    pub termination_signal: Option<String>,
    pub boundary_signal: BoundarySignal,
    pub boundary_confidence: BoundaryConfidence,
}

/// Payload for [`Event::BlockCanceled`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockCanceled {
    pub block_id: BlockId,
}

/// Payload for [`Event::BlockDetached`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockDetached {
    pub block_id: BlockId,
    pub reason: DetachReason,
}

/// Why a block detached from the session (ADR 0004).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetachReason {
    BackgroundJob,
    SidecarCrash,
    SessionEnd,
}

/// Payload for [`Event::BlockTuiEntered`] (ADR 0008).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockTuiEntered {
    pub block_id: BlockId,
}

/// Payload for [`Event::BlockTuiExited`] (ADR 0008).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockTuiExited {
    pub block_id: BlockId,
    pub bytes_written: u64,
    pub unclean: bool,
}

// --- output payloads ---

/// Which PTY stream produced a chunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

/// Payload for [`Event::OutputChunk`]: a contiguous span of bytes.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutputChunk {
    pub span_id: SpanId,
    pub block_id: BlockId,
    pub stream: OutputStream,
    pub seq: u64,
    pub byte_offset_start: u64,
    pub byte_offset_end: u64,
    /// Base64-encoded bytes. UTF-8 is not assumed; PTY may emit partial sequences.
    pub bytes_b64: String,
}

/// Payload for [`Event::OutputTruncated`] (ADR 0005).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutputTruncated {
    pub block_id: BlockId,
    pub truncated_at_bytes: u64,
    pub reason: TruncationReason,
}

/// Why output was truncated (ADR 0005).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TruncationReason {
    PerBlockCap,
    QuotaExceeded,
}

// --- input ---

/// Payload for [`Event::InputSubmitted`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InputSubmitted {
    pub text: String,
    /// Renamed from `kind` to avoid collision with the enum-level `#[serde(tag = "kind")]`
    /// discriminator. A JSON payload for `InputSubmitted` now carries `{"kind": "input_submitted", "input_kind": "shell", ...}`.
    pub input_kind: InputKind,
}

// --- diagnostic ---

/// Severity of an extracted diagnostic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

/// Broad category a diagnostic originated from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCategory {
    Compiler,
    Linter,
    Runtime,
    Test,
    Infra,
    Shell,
    Unknown,
}

/// Payload for [`Event::DiagnosticDetected`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiagnosticDetected {
    pub diagnostic_id: DiagnosticId,
    pub block_id: BlockId,
    pub parser_id: String,
    pub category: DiagnosticCategory,
    pub severity: DiagnosticSeverity,
    pub confidence: f32,
    pub message: String,
    pub path: Option<PathBuf>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    pub symbol: Option<String>,
}

// --- suggestion ---

/// Risk tier for a suggested command, ordered low → high.
///
/// Per [ADR 0012], composition rules require a monotonic risk order:
/// `safe_readonly < workspace_write < system_mutation < network_external < destructive`.
/// The derived `PartialOrd`/`Ord` follow the declaration order and are the
/// single source of truth for that comparison.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    SafeReadonly,
    WorkspaceWrite,
    SystemMutation,
    NetworkExternal,
    Destructive,
}

/// What the user did with a suggestion (ADR 0012).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionDecision {
    Approved,
    Rejected,
    Edited,
    Canceled,
}

/// Payload for [`Event::SuggestionGenerated`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SuggestionGenerated {
    pub suggestion_id: SuggestionId,
    pub source_intent: String,
    pub command: String,
    pub explanation: String,
    pub risk_level: RiskLevel,
    pub credential_sensitive: bool,
    pub parse_unknown: bool,
    pub modifiers: Vec<String>,
}

/// Payload for [`Event::SuggestionReviewed`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SuggestionReviewed {
    pub suggestion_id: SuggestionId,
    pub decision: SuggestionDecision,
    pub final_command: Option<String>,
}

// --- history ---

/// Payload for [`Event::HistoryIndexed`] (ADR 0013).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryIndexed {
    pub block_id: BlockId,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{Envelope, Producer, SchemaVersion};

    #[test]
    fn event_roundtrips_in_envelope() {
        let ev = Event::BlockCreated(BlockCreated {
            block_id: BlockId::new(),
            ordinal: 0,
            input_text: "cargo test".into(),
            input_kind: InputKind::Shell,
            cwd: "/workspace".into(),
            cwd_source: CwdSource::Launch,
            is_compound: false,
        });
        let env = Envelope::new(SessionId::new(), 1, Producer::Block, SchemaVersion::ONE, ev);
        let s = serde_json::to_string(&env).unwrap();
        let back: Envelope<Event> = serde_json::from_str(&s).unwrap();
        assert_eq!(env.event_id, back.event_id);
        match back.payload {
            Event::BlockCreated(b) => assert_eq!(b.input_text, "cargo test"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn risk_level_ordering_is_meaningful_via_serialization() {
        let levels = [
            RiskLevel::SafeReadonly,
            RiskLevel::WorkspaceWrite,
            RiskLevel::SystemMutation,
            RiskLevel::NetworkExternal,
            RiskLevel::Destructive,
        ];
        for lvl in levels {
            let s = serde_json::to_string(&lvl).unwrap();
            let back: RiskLevel = serde_json::from_str(&s).unwrap();
            assert_eq!(lvl, back);
        }
    }
}
