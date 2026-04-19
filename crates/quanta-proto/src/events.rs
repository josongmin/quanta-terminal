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

use crate::events_grid::{
    BellRequestedPayload, ClipboardRequestPayload, CursorMovedPayload, GridDeltaPayload,
    GridSnapshotPayload, HyperlinkAddedPayload, HyperlinkRemovedPayload, ModeChangedPayload,
    SynchronizedUpdatePayload, TitleChangedPayload,
};
use crate::ids::{BlockId, DiagnosticId, SessionId, SpanId, SuggestionId, WorkspaceId};

/// The complete union of event payloads.
///
/// # Forward compatibility
///
/// The [`Event::Unknown`] variant catches any `kind` discriminator not known to
/// this build. An old client receiving an envelope whose event kind was added
/// in a newer core deserializes into `Unknown { kind, payload }` instead of
/// crashing. Downstream consumers must either handle or explicitly ignore the
/// variant.
///
/// `#[serde(other)]` on an internally-tagged enum requires a unit variant and
/// therefore loses both the unknown tag and the payload. We need both, so we
/// hand-roll the `Serialize` and `Deserialize` impls below. The hand-rolled
/// serialize uses the same internally-tagged shape for the known variants and
/// flattens the `payload` field onto the outer object for `Unknown`, which
/// preserves bytewise round-trips (`parse → serialize → parse == parse`).
#[derive(Clone, Debug)]
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

    // --- grid (EPIC-C) ---
    /// Full grid snapshot — emitted on connect/resume/resize/revision-resync.
    /// See `crates/quanta-proto/src/events_grid.rs` for the payload.
    GridSnapshot(GridSnapshotPayload),
    /// Incremental grid delta — steady-state output.
    GridDelta(GridDeltaPayload),
    /// Cursor-only move. Decoupled so blink / idle moves don't dirty rows.
    CursorMoved(CursorMovedPayload),
    /// One or more DEC / xterm mode transitions batched atomically.
    ModeChanged(ModeChangedPayload),
    /// OSC 0 / 2 title change.
    TitleChanged(TitleChangedPayload),
    /// BEL received.
    BellRequested(BellRequestedPayload),
    /// OSC 8 hyperlink announced (id → URI table entry).
    HyperlinkAdded(HyperlinkAddedPayload),
    /// OSC 8 hyperlink retired (id released).
    HyperlinkRemoved(HyperlinkRemovedPayload),
    /// OSC 52 clipboard request (Set / Query).
    ClipboardRequest(ClipboardRequestPayload),
    /// DECSET 2026 / DCS BSU/ESU synchronized-update transition.
    SynchronizedUpdate(SynchronizedUpdatePayload),

    /// Catch-all for an unknown event kind (forward compatibility per ADR 0011).
    ///
    /// An old build that receives an event emitted by a newer core with an
    /// added `kind` lands here, carrying the raw tag and the raw body so a
    /// downstream consumer can log, forward, or ignore it without crashing.
    ///
    /// This variant is NEVER produced by the Rust core itself — it only appears
    /// on the deserialize path. Serializing an `Unknown` round-trips the
    /// original tag and body verbatim (the payload is flattened back onto the
    /// outer object and the `kind` field is reinstated), so "decoded then
    /// re-encoded" unknown events are byte-identical to the input modulo JSON
    /// object-key ordering.
    Unknown {
        kind: String,
        payload: serde_json::Value,
    },
}

impl Serialize for Event {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // For the known variants, re-use the derived shape by routing through
        // `KnownEventOwned`. For `Unknown`, re-assemble the original JSON
        // object (payload + `kind`) and serialize that.
        match self {
            Event::Unknown { kind, payload } => {
                let mut obj = match payload {
                    serde_json::Value::Object(map) => map.clone(),
                    // An `Unknown` whose payload is not an object can still be
                    // serialized — we wrap the body as `{ "payload": <body> }`
                    // so the tag survives. This is a defensive branch; the
                    // deserializer only ever produces object payloads.
                    other => {
                        let mut map = serde_json::Map::new();
                        map.insert("payload".to_string(), other.clone());
                        map
                    }
                };
                obj.insert("kind".to_string(), serde_json::Value::String(kind.clone()));
                serde_json::Value::Object(obj).serialize(serializer)
            }
            _ => KnownEventRef::from_event(self)
                .expect("non-Unknown variants always have a KnownEventRef mirror")
                .serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Event {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Strategy: deserialize as an arbitrary JSON value, pull out `kind`,
        // then dispatch. Unknown tags fall through to `Event::Unknown`. This
        // is O(payload size) for a single extra allocation but keeps the
        // forward-compat path simple and total.
        let raw = serde_json::Value::deserialize(deserializer)?;
        let Some(obj) = raw.as_object() else {
            return Err(serde::de::Error::custom(
                "Event payload must be a JSON object carrying a `kind` tag",
            ));
        };
        let kind = obj
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("Event payload missing `kind` discriminator"))?
            .to_string();

        // Known tags: round-trip through the generated code by feeding the
        // same JSON back to a derived companion. Using a helper enum that
        // matches the original shape avoids duplicating every variant here.
        if let Ok(known) = KnownEvent::from_value(raw.clone()) {
            Ok(known.into_event())
        } else {
            // Fall through to the catch-all variant. Strip the `kind`
            // field from the payload so downstream consumers see a clean
            // body (the kind is available on the variant).
            let mut payload = raw;
            if let Some(obj) = payload.as_object_mut() {
                obj.remove("kind");
            }
            Ok(Event::Unknown { kind, payload })
        }
    }
}

/// Private mirror of every known `Event` variant, derived so serde handles
/// the field-level deserialization. Kept private: no-one outside this module
/// needs it, and it must stay in lock-step with `Event`'s known variants.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum KnownEvent {
    SessionCreated(SessionCreated),
    SessionShellIntegrationStatus(SessionShellIntegrationStatus),
    SessionCwdChanged(SessionCwdChanged),
    SessionEnded(SessionEnded),
    BlockCreated(BlockCreated),
    BlockStarted(BlockStarted),
    BlockCompleted(BlockCompleted),
    BlockCanceled(BlockCanceled),
    BlockDetached(BlockDetached),
    BlockTuiEntered(BlockTuiEntered),
    BlockTuiExited(BlockTuiExited),
    OutputChunk(OutputChunk),
    OutputTruncated(OutputTruncated),
    InputSubmitted(InputSubmitted),
    DiagnosticDetected(DiagnosticDetected),
    SuggestionGenerated(SuggestionGenerated),
    SuggestionReviewed(SuggestionReviewed),
    HistoryIndexed(HistoryIndexed),
    GridSnapshot(GridSnapshotPayload),
    GridDelta(GridDeltaPayload),
    CursorMoved(CursorMovedPayload),
    ModeChanged(ModeChangedPayload),
    TitleChanged(TitleChangedPayload),
    BellRequested(BellRequestedPayload),
    HyperlinkAdded(HyperlinkAddedPayload),
    HyperlinkRemoved(HyperlinkRemovedPayload),
    ClipboardRequest(ClipboardRequestPayload),
    SynchronizedUpdate(SynchronizedUpdatePayload),
}

impl KnownEvent {
    fn from_value(v: serde_json::Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(v)
    }

    fn into_event(self) -> Event {
        match self {
            KnownEvent::SessionCreated(x) => Event::SessionCreated(x),
            KnownEvent::SessionShellIntegrationStatus(x) => Event::SessionShellIntegrationStatus(x),
            KnownEvent::SessionCwdChanged(x) => Event::SessionCwdChanged(x),
            KnownEvent::SessionEnded(x) => Event::SessionEnded(x),
            KnownEvent::BlockCreated(x) => Event::BlockCreated(x),
            KnownEvent::BlockStarted(x) => Event::BlockStarted(x),
            KnownEvent::BlockCompleted(x) => Event::BlockCompleted(x),
            KnownEvent::BlockCanceled(x) => Event::BlockCanceled(x),
            KnownEvent::BlockDetached(x) => Event::BlockDetached(x),
            KnownEvent::BlockTuiEntered(x) => Event::BlockTuiEntered(x),
            KnownEvent::BlockTuiExited(x) => Event::BlockTuiExited(x),
            KnownEvent::OutputChunk(x) => Event::OutputChunk(x),
            KnownEvent::OutputTruncated(x) => Event::OutputTruncated(x),
            KnownEvent::InputSubmitted(x) => Event::InputSubmitted(x),
            KnownEvent::DiagnosticDetected(x) => Event::DiagnosticDetected(x),
            KnownEvent::SuggestionGenerated(x) => Event::SuggestionGenerated(x),
            KnownEvent::SuggestionReviewed(x) => Event::SuggestionReviewed(x),
            KnownEvent::HistoryIndexed(x) => Event::HistoryIndexed(x),
            KnownEvent::GridSnapshot(x) => Event::GridSnapshot(x),
            KnownEvent::GridDelta(x) => Event::GridDelta(x),
            KnownEvent::CursorMoved(x) => Event::CursorMoved(x),
            KnownEvent::ModeChanged(x) => Event::ModeChanged(x),
            KnownEvent::TitleChanged(x) => Event::TitleChanged(x),
            KnownEvent::BellRequested(x) => Event::BellRequested(x),
            KnownEvent::HyperlinkAdded(x) => Event::HyperlinkAdded(x),
            KnownEvent::HyperlinkRemoved(x) => Event::HyperlinkRemoved(x),
            KnownEvent::ClipboardRequest(x) => Event::ClipboardRequest(x),
            KnownEvent::SynchronizedUpdate(x) => Event::SynchronizedUpdate(x),
        }
    }
}

/// Borrow-based mirror used only for serialization so the hand-rolled
/// `Serialize` impl on [`Event`] can delegate to derive-generated code for
/// every known variant without cloning payloads.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum KnownEventRef<'a> {
    SessionCreated(&'a SessionCreated),
    SessionShellIntegrationStatus(&'a SessionShellIntegrationStatus),
    SessionCwdChanged(&'a SessionCwdChanged),
    SessionEnded(&'a SessionEnded),
    BlockCreated(&'a BlockCreated),
    BlockStarted(&'a BlockStarted),
    BlockCompleted(&'a BlockCompleted),
    BlockCanceled(&'a BlockCanceled),
    BlockDetached(&'a BlockDetached),
    BlockTuiEntered(&'a BlockTuiEntered),
    BlockTuiExited(&'a BlockTuiExited),
    OutputChunk(&'a OutputChunk),
    OutputTruncated(&'a OutputTruncated),
    InputSubmitted(&'a InputSubmitted),
    DiagnosticDetected(&'a DiagnosticDetected),
    SuggestionGenerated(&'a SuggestionGenerated),
    SuggestionReviewed(&'a SuggestionReviewed),
    HistoryIndexed(&'a HistoryIndexed),
    GridSnapshot(&'a GridSnapshotPayload),
    GridDelta(&'a GridDeltaPayload),
    CursorMoved(&'a CursorMovedPayload),
    ModeChanged(&'a ModeChangedPayload),
    TitleChanged(&'a TitleChangedPayload),
    BellRequested(&'a BellRequestedPayload),
    HyperlinkAdded(&'a HyperlinkAddedPayload),
    HyperlinkRemoved(&'a HyperlinkRemovedPayload),
    ClipboardRequest(&'a ClipboardRequestPayload),
    SynchronizedUpdate(&'a SynchronizedUpdatePayload),
}

impl<'a> KnownEventRef<'a> {
    /// Returns `None` for `Event::Unknown`; that variant has no mirror and is
    /// handled inline by the `Serialize` impl on [`Event`].
    fn from_event(ev: &'a Event) -> Option<Self> {
        Some(match ev {
            Event::SessionCreated(x) => KnownEventRef::SessionCreated(x),
            Event::SessionShellIntegrationStatus(x) => {
                KnownEventRef::SessionShellIntegrationStatus(x)
            }
            Event::SessionCwdChanged(x) => KnownEventRef::SessionCwdChanged(x),
            Event::SessionEnded(x) => KnownEventRef::SessionEnded(x),
            Event::BlockCreated(x) => KnownEventRef::BlockCreated(x),
            Event::BlockStarted(x) => KnownEventRef::BlockStarted(x),
            Event::BlockCompleted(x) => KnownEventRef::BlockCompleted(x),
            Event::BlockCanceled(x) => KnownEventRef::BlockCanceled(x),
            Event::BlockDetached(x) => KnownEventRef::BlockDetached(x),
            Event::BlockTuiEntered(x) => KnownEventRef::BlockTuiEntered(x),
            Event::BlockTuiExited(x) => KnownEventRef::BlockTuiExited(x),
            Event::OutputChunk(x) => KnownEventRef::OutputChunk(x),
            Event::OutputTruncated(x) => KnownEventRef::OutputTruncated(x),
            Event::InputSubmitted(x) => KnownEventRef::InputSubmitted(x),
            Event::DiagnosticDetected(x) => KnownEventRef::DiagnosticDetected(x),
            Event::SuggestionGenerated(x) => KnownEventRef::SuggestionGenerated(x),
            Event::SuggestionReviewed(x) => KnownEventRef::SuggestionReviewed(x),
            Event::HistoryIndexed(x) => KnownEventRef::HistoryIndexed(x),
            Event::GridSnapshot(x) => KnownEventRef::GridSnapshot(x),
            Event::GridDelta(x) => KnownEventRef::GridDelta(x),
            Event::CursorMoved(x) => KnownEventRef::CursorMoved(x),
            Event::ModeChanged(x) => KnownEventRef::ModeChanged(x),
            Event::TitleChanged(x) => KnownEventRef::TitleChanged(x),
            Event::BellRequested(x) => KnownEventRef::BellRequested(x),
            Event::HyperlinkAdded(x) => KnownEventRef::HyperlinkAdded(x),
            Event::HyperlinkRemoved(x) => KnownEventRef::HyperlinkRemoved(x),
            Event::ClipboardRequest(x) => KnownEventRef::ClipboardRequest(x),
            Event::SynchronizedUpdate(x) => KnownEventRef::SynchronizedUpdate(x),
            Event::Unknown { .. } => return None,
        })
    }
}

// --- session payloads ---

/// Payload for [`Event::SessionCreated`]: a new session has been minted.
///
/// `#[serde(default)]` is applied to additive / metadata fields so that an
/// older build receiving a newer event still parses cleanly. Load-bearing
/// IDs remain required.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionCreated {
    pub session_id: SessionId,
    #[serde(default)]
    pub workspace_id: Option<WorkspaceId>,
    #[serde(default)]
    pub shell: String,
    #[serde(default)]
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
    /// A durable event-log append failed; the session is fail-closed (FIX 1).
    ///
    /// The actor assigns `monotonic_seq` BEFORE it calls `EventSink::append`.
    /// A failed append burns the seq — retrying would introduce a durable gap
    /// that `ZstdSegmentedEventLog::replay_session` treats as corruption via
    /// [`crate::events::SessionEnded`] → `EventLogError::SeqGap`. Instead of
    /// compounding the error, the actor emits a terminal `SessionEnded` with
    /// this reason (best-effort) and tears down reader/input tasks so callers
    /// see the session as closed and stop issuing writes against a corrupt log.
    SinkFailure,
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
    #[serde(default)]
    pub ordinal: u64,
    #[serde(default)]
    pub input_text: String,
    pub input_kind: InputKind,
    #[serde(default)]
    pub cwd: PathBuf,
    pub cwd_source: CwdSource,
    #[serde(default)]
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
    #[serde(default)]
    pub pid: Option<u32>,
}

/// Payload for [`Event::BlockCompleted`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockCompleted {
    pub block_id: BlockId,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
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
    #[serde(default)]
    pub bytes_written: u64,
    #[serde(default)]
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
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub byte_offset_start: u64,
    #[serde(default)]
    pub byte_offset_end: u64,
    /// Base64-encoded bytes. UTF-8 is not assumed; PTY may emit partial sequences.
    #[serde(default)]
    pub bytes_b64: String,
}

/// Payload for [`Event::OutputTruncated`] (ADR 0005).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutputTruncated {
    pub block_id: BlockId,
    #[serde(default)]
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
    #[serde(default)]
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
    #[serde(default)]
    pub parser_id: String,
    pub category: DiagnosticCategory,
    pub severity: DiagnosticSeverity,
    #[serde(default)]
    pub confidence: f32,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub path: Option<PathBuf>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    #[serde(default)]
    pub end_line: Option<u32>,
    #[serde(default)]
    pub end_column: Option<u32>,
    #[serde(default)]
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
    #[serde(default)]
    pub source_intent: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub explanation: String,
    pub risk_level: RiskLevel,
    #[serde(default)]
    pub credential_sensitive: bool,
    #[serde(default)]
    pub parse_unknown: bool,
    #[serde(default)]
    pub modifiers: Vec<String>,
}

/// Payload for [`Event::SuggestionReviewed`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SuggestionReviewed {
    pub suggestion_id: SuggestionId,
    pub decision: SuggestionDecision,
    #[serde(default)]
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

    /// Forward-compat: an event with a `kind` this build does not recognize
    /// deserializes into `Event::Unknown` instead of returning an error. The
    /// raw tag and the residual payload survive so callers can log the fact
    /// of the unknown event without a panic.
    #[test]
    fn unknown_event_kind_deserializes_to_catch_all() {
        let json = r#"{
            "kind": "block.quantum_tunneled",
            "block_id": "01J0000000000000000000ABCD",
            "extra_field": 42
        }"#;
        let ev: Event = serde_json::from_str(json).expect("unknown kind must not error");
        match ev {
            Event::Unknown { kind, payload } => {
                assert_eq!(kind, "block.quantum_tunneled");
                // `kind` must be stripped from the residual payload so a
                // consumer doesn't see it twice.
                assert!(
                    payload.get("kind").is_none(),
                    "`kind` must be stripped from residual payload"
                );
                assert_eq!(
                    payload
                        .get("extra_field")
                        .and_then(serde_json::Value::as_i64),
                    Some(42)
                );
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    /// Forward-compat regression: the presence of `Unknown` must not swallow
    /// a real variant. A JSON with a known tag still roundtrips to the typed
    /// variant.
    #[test]
    fn known_event_kinds_still_deserialize_to_typed_variant() {
        let created = Event::BlockCreated(BlockCreated {
            block_id: BlockId::new(),
            ordinal: 0,
            input_text: "ls".into(),
            input_kind: InputKind::Shell,
            cwd: "/tmp".into(),
            cwd_source: CwdSource::Launch,
            is_compound: false,
        });
        let s = serde_json::to_string(&created).unwrap();
        let back: Event = serde_json::from_str(&s).unwrap();
        assert!(
            matches!(back, Event::BlockCreated(_)),
            "known kind must round-trip; got {back:?}"
        );
    }

    /// Envelope carrying an unknown event does not panic during decode.
    #[test]
    fn envelope_with_unknown_event_does_not_panic() {
        let raw = serde_json::json!({
            "event_id": "01J0000000000000000000ABCD",
            "monotonic_seq": 7,
            "session_id": "01J0000000000000000000XYZZ",
            "block_id": null,
            "wall_clock_ts": "2026-04-19T10:00:00Z",
            "producer_id": "core",
            "schema_version": 1,
            "causation_id": null,
            "payload": {
                "kind": "block.teleported",
                "something_new": "yes"
            }
        });
        let env: Envelope<Event> = serde_json::from_value(raw).unwrap();
        match env.payload {
            Event::Unknown { kind, .. } => assert_eq!(kind, "block.teleported"),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }
}
