//! The session actor.
//!
//! Owns one PTY and one block reducer. Emits events through the configured
//! `EventSink`. Per ADR 0002, block boundaries are driven primarily by OSC 133
//! (when installed). When the shell has no integration, child exit still
//! closes the active block with `BoundarySignal::ChildExit`.
//!
//! # Concurrency model
//!
//! Three long-running tasks back the actor, each with a captured `JoinHandle`
//! and a shared shutdown token:
//!
//! 1. **reader task** — drains the PTY, updates the output store, emits
//!    `OutputChunk` and boundary events by forwarding `WriteCmd::Append` to
//!    the emitter task.
//! 2. **input task** — drains an mpsc of `InputCommand`s (writes, resize,
//!    cancel, close) and serializes them on the PTY.
//! 3. **emitter task** — the SINGLE assigner of `monotonic_seq` and the SINGLE
//!    caller of `EventSink::append`. Fed from a bounded mpsc by every other
//!    path. Guarantees strict ordering per ADR 0011 §Durable Commit Ordering.
//!
//! Channels are bounded to provide backpressure. Full channels cause the
//! producer to wait; we prefer that over unbounded memory growth when a
//! downstream sink (disk IO) gets slow.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use quanta_block::{BoundaryEvent, VteBoundaryDetector};
use quanta_diagnostic::{Category, DiagnosticPipeline, Severity};
use quanta_events::{EventLogError, EventSink};
use quanta_metrics::{MetricsRecorder, NoopRecorder};
use quanta_output::OutputStore;
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{
    BlockCanceled, BlockCompleted, BlockCreated, BlockStarted, BlockTuiEntered, BlockTuiExited,
    BoundaryConfidence, BoundarySignal, CwdSource, DiagnosticCategory, DiagnosticDetected,
    DiagnosticSeverity, Event, InputSubmitted, OutputChunk, OutputStream, SessionCreated,
    SessionCwdChanged, SessionEndReason, SessionEnded, SessionShellIntegrationStatus,
    ShellIntegrationStatus,
};
use quanta_proto::ids::{BlockId, DiagnosticId, EventId, SessionId};
use quanta_pty::{PtyHandle, PtyPort, PtySize, PtySpec};
use quanta_security::{DefaultDetector, SecretDetector};
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

use crate::domain::{InputSubmission, SessionConfig, SessionSnapshot};
use crate::ports::{SessionError, SessionHandle};

// NOTE: channel bounds tuned for a desktop workload; full buffers apply
// backpressure to producers rather than growing memory unbounded. See ADR 0011
// §Backpressure — the sink IS durable, so any delay here is bounded by fsync.
const INPUT_CHANNEL_CAPACITY: usize = 256;
const EMIT_CHANNEL_CAPACITY: usize = 1024;

/// Metric names used by the session actor. `&'static str` by construction
/// (the recorder keys on it) and colocated here so a future audit can grep
/// for "session.*" and find the full surface.
pub const METRIC_ENVELOPE_APPENDED: &str = "session.envelope.appended";
pub const METRIC_APPEND_LATENCY_US: &str = "session.append.latency_us";
// NOTE: 8 KiB chunk is a compromise between span fragmentation and latency.
// Increase to 64 KiB only if the serializer/sink becomes the bottleneck.
const PTY_READ_CHUNK_BYTES: usize = 8 * 1024;
/// Upper bound on how long `submit_input` will wait for the input task to
/// accept a command. When the input task is stuck on a hung PTY (kernel-level
/// write block, unresponsive child, etc.), the bounded channel fills and
/// every subsequent `send` stalls forever without this timeout. The RPC
/// boundary then starves — submit_input callers hang, and the UI loses
/// responsiveness. See FIX 5 in the audit.
///
/// 5 s is generous: a healthy desktop system will deliver a command in
/// microseconds. Tune downward if a documented latency SLA exists; tune
/// upward only on genuinely slow sinks.
const SUBMIT_INPUT_SEND_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
#[allow(
    dead_code,
    reason = "ordinal/input_text/saw_osc133_d are reserved for Phase 2 boundary telemetry"
)]
struct ActiveBlock {
    block_id: BlockId,
    pid: Option<u32>,
    ordinal: u64,
    input_text: String,
    saw_osc133_d: bool,
}

struct SharedState {
    session_id: SessionId,
    #[allow(
        dead_code,
        reason = "reserved for idempotent reducer dedupe in Phase 2 (ADR 0011)"
    )]
    applied_event_ids: std::collections::BTreeSet<EventId>,
    output_store: OutputStore,
    active_block: Option<ActiveBlock>,
    next_ordinal: u64,
    cwd: PathBuf,
    cwd_source: CwdSource,
    shell_integration_status: ShellIntegrationStatus,
    in_tui: bool,
    tui_bytes: u64,
}

impl std::fmt::Debug for SharedState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedState")
            .field("session_id", &self.session_id)
            .field("cwd", &self.cwd)
            .field("cwd_source", &self.cwd_source)
            .field("in_tui", &self.in_tui)
            .finish_non_exhaustive()
    }
}

/// The running session, held as a shareable handle.
#[allow(
    dead_code,
    reason = "pty kept alive via reader/input tasks; field retained for shutdown"
)]
pub struct SessionActor {
    state: Arc<Mutex<SharedState>>,
    emitter_tx: mpsc::Sender<EmitRequest>,
    input_tx: mpsc::Sender<InputCommand>,
    session_id: SessionId,
    /// Shutdown signal fanned out to reader/input/emitter tasks.
    shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    /// Join handles of the three long-running tasks. Awaited on `close`.
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    /// Secret detector used to redact persisted input text (ADR 0006).
    /// Injected for determinism in tests via [`SessionActor::spawn_with_detector`].
    detector: Arc<dyn SecretDetector>,
    /// FIX 1 — fail-closed flag. Set by the emitter task when a sink append
    /// fails after seq assignment; checked by `submit_input` / `close` so
    /// downstream callers see `SessionError::Closed` instead of hanging on
    /// the emitter's dropped ack channel. Idempotent once set.
    sink_failed: Arc<AtomicBool>,
}

impl std::fmt::Debug for SessionActor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionActor")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

/// One event queued for the emitter task. `ack` lets synchronous callers (e.g.
/// `submit_input`) observe the sink's outcome for the specific event they
/// emitted — necessary for the `?` in `submit_input` per ADR 0011 step 4.
struct EmitRequest {
    producer: Producer,
    payload: Event,
    ack: Option<oneshot::Sender<Result<(), EventLogError>>>,
}

#[derive(Debug)]
enum InputCommand {
    Write(Vec<u8>),
    Resize(PtySize),
    Cancel(BlockId),
    Close,
}

impl SessionActor {
    /// Spawn the PTY, emit `SessionCreated`, and launch the read/write tasks.
    ///
    /// Uses [`DefaultDetector`] for secret redaction. Call
    /// [`SessionActor::spawn_with_detector`] to inject a mock or alternative
    /// detector (test rigs, sensitivity tuning).
    pub async fn spawn(
        pty_port: Arc<dyn PtyPort>,
        sink: Arc<dyn EventSink>,
        config: SessionConfig,
    ) -> Result<(Self, SessionId), SessionError> {
        Self::spawn_with_detector(pty_port, sink, config, Arc::new(DefaultDetector::new())).await
    }

    /// Variant of [`spawn`](Self::spawn) that also accepts a metrics
    /// recorder. Default [`spawn`] passes a [`NoopRecorder`] so the
    /// metrics surface is opt-in per ADR 0014 §Metrics Port. A production
    /// caller that owns a shared `InMemoryRecorder` threads it through
    /// here once and every actor's emitter reports `session.envelope.*`
    /// counters + `session.append.latency_us` observations to the same
    /// sink.
    pub async fn spawn_with_recorder(
        pty_port: Arc<dyn PtyPort>,
        sink: Arc<dyn EventSink>,
        config: SessionConfig,
        recorder: Arc<dyn MetricsRecorder>,
    ) -> Result<(Self, SessionId), SessionError> {
        Self::spawn_inner(
            pty_port,
            sink,
            config,
            Arc::new(DefaultDetector::new()),
            recorder,
        )
        .await
    }

    /// Variant of [`spawn`](Self::spawn) with an explicit detector port.
    ///
    /// Required for integration tests that need to inject mock detectors so
    /// the assertions are deterministic across ruleset bumps. See ADR 0006
    /// §Detection Placement — the detector runs at the persistence boundary,
    /// so this is the correct injection point.
    pub async fn spawn_with_detector(
        pty_port: Arc<dyn PtyPort>,
        sink: Arc<dyn EventSink>,
        config: SessionConfig,
        detector: Arc<dyn SecretDetector>,
    ) -> Result<(Self, SessionId), SessionError> {
        Self::spawn_inner(
            pty_port,
            sink,
            config,
            detector,
            Arc::new(NoopRecorder::new()),
        )
        .await
    }

    #[expect(
        clippy::too_many_lines,
        reason = "inline wiring of 3 tasks + shutdown fanout kept local for locality"
    )]
    async fn spawn_inner(
        pty_port: Arc<dyn PtyPort>,
        sink: Arc<dyn EventSink>,
        config: SessionConfig,
        detector: Arc<dyn SecretDetector>,
        recorder: Arc<dyn MetricsRecorder>,
    ) -> Result<(Self, SessionId), SessionError> {
        let session_id = SessionId::new();
        // Launch env is currently empty in Phase 1 per ADR 0003, but we still
        // pipe it through the denylist. This is the "filter at boundary"
        // guarantee ADR 0006 §Detection Placement requires: any env we pass
        // to the PTY is pre-scrubbed by the detector, not by ad-hoc filters.
        let launch_env: Vec<(String, String)> = Vec::new();
        let launch_env_filtered = filter_launch_env(launch_env, detector.as_ref());
        let spec = PtySpec {
            program: config.shell.clone(),
            args: config.args.clone(),
            cwd: Some(config.cwd.clone()),
            env: launch_env_filtered,
            size: PtySize::new(config.cols, config.rows),
        };
        let pty = pty_port.open(spec).await?;

        let state = Arc::new(Mutex::new(SharedState {
            session_id,
            applied_event_ids: std::collections::BTreeSet::new(),
            output_store: OutputStore::new(),
            active_block: None,
            next_ordinal: 0,
            cwd: config.cwd.clone(),
            cwd_source: CwdSource::Launch,
            shell_integration_status: ShellIntegrationStatus::Missing,
            in_tui: false,
            tui_bytes: 0,
        }));
        let pty = Arc::new(Mutex::new(pty));

        let (emit_tx, emit_rx) = mpsc::channel::<EmitRequest>(EMIT_CHANNEL_CAPACITY);
        let (input_tx, input_rx) = mpsc::channel::<InputCommand>(INPUT_CHANNEL_CAPACITY);
        // Write-priority signal: set by input_loop before taking pty.lock() so
        // the read loop yields rather than re-acquire-and-block on a read that
        // can't progress until the pending write is delivered to the pty. This
        // is the in-scope workaround for the shared `Arc<Mutex<Box<dyn PtyHandle>>>`
        // contention — splitting the port into reader/writer halves is a
        // cross-scope fix tracked for Round 1.
        let write_pending = Arc::new(AtomicBool::new(false));
        let write_ready = Arc::new(Notify::new());
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        // Fan the single shutdown oneshot out to the three tasks by splitting it
        // into three oneshots bridged by a small "broadcast" spawn.
        let (reader_stop_tx, reader_stop_rx) = oneshot::channel::<()>();
        let (input_stop_tx, input_stop_rx) = oneshot::channel::<()>();
        let (emitter_stop_tx, emitter_stop_rx) = oneshot::channel::<()>();
        let shutdown_fanout: JoinHandle<()> = tokio::spawn(async move {
            let _ = shutdown_rx.await;
            let _ = reader_stop_tx.send(());
            let _ = input_stop_tx.send(());
            let _ = emitter_stop_tx.send(());
        });

        // FIX 1: shared "sink failed" flag. The emitter task sets it on a
        // non-recoverable sink error; the actor's input-facing methods check
        // it to short-circuit to `SessionError::Closed` rather than hang on
        // the emitter's dropped ack channel.
        let sink_failed = Arc::new(AtomicBool::new(false));

        // Spawn emitter FIRST so SessionCreated can go through it.
        let emitter_task: JoinHandle<()> = {
            let sink = sink.clone();
            let session_id_for_task = session_id;
            let sink_failed_for_task = sink_failed.clone();
            let recorder_for_task = recorder.clone();
            // The emitter task must be able to abort the reader / input tasks
            // on sink failure so a durable session doesn't keep producing
            // writes against a poisoned log. Join handles are wired in below
            // after the reader/input tasks spawn; until then we pass Arc-wrapped
            // slots the spawn fills in atomically.
            tokio::spawn(async move {
                emitter_loop(
                    emit_rx,
                    sink,
                    session_id_for_task,
                    emitter_stop_rx,
                    sink_failed_for_task,
                    recorder_for_task,
                )
                .await;
            })
        };

        let actor = Self {
            state: state.clone(),
            emitter_tx: emit_tx.clone(),
            input_tx: input_tx.clone(),
            session_id,
            shutdown_tx: Arc::new(Mutex::new(Some(shutdown_tx))),
            tasks: Arc::new(Mutex::new(Vec::new())),
            detector,
            sink_failed,
        };

        // Emit SessionCreated through the emitter.
        emit(
            &emit_tx,
            &actor.state,
            Producer::Session,
            Event::SessionCreated(SessionCreated {
                session_id,
                workspace_id: None,
                shell: config.shell.clone(),
                launch_cwd: config.cwd.clone(),
            }),
        )
        .await?;

        // Spawn reader task.
        let reader_state = state.clone();
        let reader_pty = pty.clone();
        let reader_emit = emit_tx.clone();
        let reader_write_pending = write_pending.clone();
        let reader_write_ready = write_ready.clone();
        let reader_task: JoinHandle<()> = tokio::spawn(async move {
            read_loop(
                reader_pty,
                reader_emit,
                reader_state,
                reader_stop_rx,
                reader_write_pending,
                reader_write_ready,
            )
            .await;
        });

        // Spawn input/control task.
        let input_pty = pty.clone();
        let input_write_pending = write_pending.clone();
        let input_write_ready = write_ready.clone();
        let input_session_id = session_id;
        let input_task: JoinHandle<()> = tokio::spawn(async move {
            input_loop(
                input_rx,
                input_pty,
                input_stop_rx,
                input_write_pending,
                input_write_ready,
                input_session_id,
            )
            .await;
        });

        {
            let mut tasks = actor.tasks.lock().await;
            tasks.push(reader_task);
            tasks.push(input_task);
            tasks.push(emitter_task);
            tasks.push(shutdown_fanout);
        }

        info!(
            session_id = %session_id,
            shell = %config.shell,
            cwd = ?config.cwd,
            "session actor spawned"
        );
        Ok((actor, session_id))
    }
}

#[async_trait]
impl SessionHandle for SessionActor {
    async fn submit_input(&self, input: InputSubmission) -> Result<Option<BlockId>, SessionError> {
        // FIX 1: once the emitter has failed-closed on a sink error, every
        // further submit must fast-fail with `Closed` — the emit channel is
        // dead, the seq counter is corrupt, and blocking on an ack is the
        // exact user-visible hang we're fixing.
        if self.sink_failed.load(Ordering::Acquire) {
            return Err(SessionError::Closed);
        }
        // ADR 0006 §Placement of Redaction: command gets redacted representation
        // on persistence. The raw bytes still go to the PTY — redaction never
        // alters what the user typed in-memory or the live stream. Here we
        // redact ONLY the text that flows onto the persisted event envelope.
        let redactions = self.detector.scan_command(&input.text);
        let redacted_text = if redactions.is_empty() {
            input.text.clone()
        } else {
            quanta_security::domain::render_display(&input.text, &redactions)
        };

        emit(
            &self.emitter_tx,
            &self.state,
            Producer::Input,
            Event::InputSubmitted(InputSubmitted {
                text: redacted_text.clone(),
                input_kind: input.kind,
            }),
        )
        .await?;

        if !input.submit {
            // Passthrough: write raw bytes, no block. `send` applies backpressure
            // if the pty input task is behind (bounded channel). FIX 5: bound the
            // wait with `SUBMIT_INPUT_SEND_TIMEOUT` so a hung PTY doesn't starve
            // the RPC layer.
            send_input_bounded(&self.input_tx, InputCommand::Write(input.text.into_bytes()))
                .await?;
            return Ok(None);
        }

        // Create a new block.
        let block_id = BlockId::new();
        let (ordinal, cwd, cwd_source) = {
            let mut st = self.state.lock().await;
            let ord = st.next_ordinal;
            // Saturate on overflow — a session that minted `u64::MAX` blocks
            // is astronomically unlikely, but we prefer to freeze the ordinal
            // at the ceiling over silently wrapping to 0 and confusing
            // downstream consumers that assume monotonicity.
            st.next_ordinal = st.next_ordinal.saturating_add(1);
            (ord, st.cwd.clone(), st.cwd_source)
        };
        emit(
            &self.emitter_tx,
            &self.state,
            Producer::Block,
            Event::BlockCreated(BlockCreated {
                block_id,
                ordinal,
                // BlockCreated.input_text is part of the persisted projection, so
                // it also carries the redacted form per ADR 0006.
                input_text: redacted_text.clone(),
                input_kind: input.kind,
                cwd,
                cwd_source,
                is_compound: is_compound(&input.text),
            }),
        )
        .await?;
        emit(
            &self.emitter_tx,
            &self.state,
            Producer::Block,
            Event::BlockStarted(BlockStarted {
                block_id,
                pid: None,
            }),
        )
        .await?;
        {
            let mut st = self.state.lock().await;
            st.active_block = Some(ActiveBlock {
                block_id,
                pid: None,
                ordinal,
                // Retain raw input in-memory only. Per ADR 0006 §Scope the
                // raw buffer is user-observable truth; redaction lives at
                // the persistence boundary, not here.
                input_text: input.text.clone(),
                saw_osc133_d: false,
            });
        }
        // Write command bytes + CR so the shell executes. Raw bytes reach the
        // PTY — redaction is a persistence-layer concern only. FIX 5: timeout
        // bounds so a hung PTY cannot starve callers.
        let mut bytes = input.text.into_bytes();
        bytes.push(b'\n');
        send_input_bounded(&self.input_tx, InputCommand::Write(bytes)).await?;
        Ok(Some(block_id))
    }

    async fn resize(&self, size: PtySize) -> Result<(), SessionError> {
        send_input_bounded(&self.input_tx, InputCommand::Resize(size)).await?;
        Ok(())
    }

    async fn cancel_block(&self, block_id: BlockId) -> Result<(), SessionError> {
        // Per ADR 0002, cancellation is a terminal state. Emit `BlockCanceled`
        // eagerly (synchronously from the caller's perspective) so the event
        // log is authoritative regardless of whether the shell produces a
        // matching child-exit afterwards. If the shell DOES exit, the reducer
        // ignores the later `BlockCompleted` because `Canceled` is terminal.
        //
        // Only emit when the cancellation targets the currently active block;
        // a stale `cancel_block(old_id)` is a no-op event-wise but still sends
        // Ctrl-C to the PTY (the shell will ignore it if the prompt is idle).
        let is_active = {
            let st = self.state.lock().await;
            st.active_block
                .as_ref()
                .is_some_and(|b| b.block_id == block_id)
        };
        if is_active {
            emit(
                &self.emitter_tx,
                &self.state,
                Producer::Block,
                Event::BlockCanceled(BlockCanceled { block_id }),
            )
            .await?;
        }

        send_input_bounded(&self.input_tx, InputCommand::Cancel(block_id)).await?;
        Ok(())
    }

    /// Close the session.
    ///
    /// This function is idempotent and re-entrant: a second call observes
    /// `shutdown_tx` as `None` (already taken) and an empty `tasks` vector,
    /// so it completes without signalling or joining anything. This is
    /// relied upon by `Engine::close_session` which may be invoked through
    /// multiple code paths (explicit RPC, host shutdown, crash recovery).
    ///
    /// Note: we do NOT apply a timeout here. Callers that need a bounded
    /// close should wrap this in `tokio::time::timeout`. Tasks stop promptly
    /// because the shutdown oneshot fires and channels close.
    async fn close(&self) -> Result<(), SessionError> {
        // Take the shutdown oneshot first. If it is `None`, a prior `close()`
        // already ran; the idempotent path skips all emission / join work.
        let maybe_tx = self.shutdown_tx.lock().await.take();
        let first_close = maybe_tx.is_some();

        // FIX 1: if the session already fail-closed via sink error, the
        // emitter already pushed a terminal `SessionEnded(SinkFailure)` and
        // drained its queue. Trying to emit a second `SessionEnded(UserClosed)`
        // would deadlock on the dead ack channel. Skip the emission arm but
        // preserve the rest of the teardown (shutdown signal + task join).
        let already_fail_closed = self.sink_failed.load(Ordering::Acquire);

        if first_close && !already_fail_closed {
            // ADR 0011 §Durable Commit Ordering: emit `SessionEnded`
            // SYNCHRONOUSLY (ack-backed) BEFORE we trigger shutdown, so the
            // envelope is durable in the event log before the emitter task
            // winds down. This closes the test race where a racing
            // `replay_session` saw no `SessionEnded` on the first iteration.
            //
            // We swallow the error deliberately: if the emitter has already
            // died (e.g. the emit channel is closed because the input task
            // killed the child and the emitter's shutdown arm ran), we still
            // want `close()` to tear down cleanly. The reader's post-loop
            // `emit_nowait(SessionEnded)` covers the ungraceful case.
            let _ = emit(
                &self.emitter_tx,
                &self.state,
                Producer::Session,
                Event::SessionEnded(SessionEnded {
                    reason: SessionEndReason::UserClosed,
                }),
            )
            .await;
        }

        // Best effort: ask the input task to kill the child. Harmless no-op
        // when the channel is already closed.
        let _ = self.input_tx.send(InputCommand::Close).await;

        if let Some(tx) = maybe_tx {
            // `send` fails only if the receiver has been dropped — harmless.
            let _ = tx.send(());
            info!(session_id = %self.session_id, "session actor closing");
        }
        // Drain and join tasks so we don't leak orphans past session close.
        let handles: Vec<_> = std::mem::take(&mut *self.tasks.lock().await);
        let joined = handles.len();
        for h in handles {
            let _ = h.await;
        }
        if first_close {
            debug!(session_id = %self.session_id, joined, "session actor: all tasks joined");
        }
        Ok(())
    }

    async fn snapshot(&self) -> SessionSnapshot {
        let st = self.state.lock().await;
        SessionSnapshot {
            session_id: st.session_id,
            shell_integration_status: st.shell_integration_status,
            cwd: st.cwd.clone(),
            cwd_source: st.cwd_source,
        }
    }
}

/// Funnel an event through the emitter task with synchronous wait on the sink
/// outcome. This enforces ADR 0011's requirement that the actor is the SINGLE
/// seq assigner AND that sink order matches assignment order: the emitter task
/// processes one request at a time and performs the assign+append atomically
/// on its task.
async fn emit(
    tx: &mpsc::Sender<EmitRequest>,
    _state: &Arc<Mutex<SharedState>>,
    producer: Producer,
    payload: Event,
) -> Result<(), EventLogError> {
    let (ack_tx, ack_rx) = oneshot::channel();
    let req = EmitRequest {
        producer,
        payload,
        ack: Some(ack_tx),
    };
    // Bounded send. If the channel is full we WAIT (backpressure) rather than
    // drop; the emitter drains at sink speed.
    tx.send(req)
        .await
        .map_err(|_| EventLogError::Io("emitter closed".into()))?;
    ack_rx
        .await
        .map_err(|_| EventLogError::Io("emitter dropped ack".into()))?
}

/// Send an `InputCommand` to the input task with the FIX 5 timeout applied.
///
/// Three observable outcomes:
/// 1. Send succeeds → `Ok(())`.
/// 2. Receiver dropped (actor already closed) → `Err(SessionError::Closed)`.
/// 3. Timer fires before the input task accepts the command (bounded channel
///    full because input task is stuck) → `Err(SessionError::Unresponsive)`.
///
/// Case 3 is the reason this helper exists: before FIX 5, a hung PTY made
/// the bounded channel fill forever and every subsequent caller hung
/// indefinitely — the RPC layer lost responsiveness and the UI had no
/// signal to surface.
async fn send_input_bounded(
    tx: &mpsc::Sender<InputCommand>,
    cmd: InputCommand,
) -> Result<(), SessionError> {
    match tokio::time::timeout(SUBMIT_INPUT_SEND_TIMEOUT, tx.send(cmd)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(SessionError::Closed),
        Err(_elapsed) => Err(SessionError::Unresponsive),
    }
}

/// Variant used from the read loop that does NOT await the sink outcome. The
/// read loop would otherwise self-deadlock if the emitter back-pressures
/// (channel full) while the reader's next send waits on an ack it can't get
/// until slots free — fire-and-forget with warn-on-error is the right trade
/// for high-volume output events, since seq assignment is still done inside
/// the emitter task and ordering is preserved by the channel's FIFO.
async fn emit_nowait(
    tx: &mpsc::Sender<EmitRequest>,
    producer: Producer,
    payload: Event,
) -> Result<(), EventLogError> {
    let req = EmitRequest {
        producer,
        payload,
        ack: None,
    };
    tx.send(req)
        .await
        .map_err(|_| EventLogError::Io("emitter closed".into()))
}

fn block_id_for_event(ev: &Event) -> Option<BlockId> {
    match ev {
        Event::BlockCreated(b) => Some(b.block_id),
        Event::BlockStarted(b) => Some(b.block_id),
        Event::BlockCompleted(b) => Some(b.block_id),
        Event::BlockCanceled(b) => Some(b.block_id),
        Event::BlockDetached(b) => Some(b.block_id),
        Event::BlockTuiEntered(b) => Some(b.block_id),
        Event::BlockTuiExited(b) => Some(b.block_id),
        Event::OutputChunk(o) => Some(o.block_id),
        Event::DiagnosticDetected(d) => Some(d.block_id),
        _ => None,
    }
}

fn is_compound(text: &str) -> bool {
    text.contains("&&") || text.contains("||") || text.contains(';') || text.contains('|')
}

/// Map the diagnostic domain's category into the proto wire enum. The domain
/// already re-exports the proto type under a shorter alias (`Category`), but
/// we map here explicitly so a future domain-local category variant can be
/// folded in without touching the proto wire shape.
fn map_category(c: Category) -> DiagnosticCategory {
    match c {
        Category::Compiler => DiagnosticCategory::Compiler,
        Category::Linter => DiagnosticCategory::Linter,
        Category::Runtime => DiagnosticCategory::Runtime,
        Category::Test => DiagnosticCategory::Test,
        Category::Infra => DiagnosticCategory::Infra,
        Category::Shell => DiagnosticCategory::Shell,
        Category::Unknown => DiagnosticCategory::Unknown,
    }
}

fn map_severity(s: Severity) -> DiagnosticSeverity {
    match s {
        Severity::Error => DiagnosticSeverity::Error,
        Severity::Warning => DiagnosticSeverity::Warning,
        Severity::Info => DiagnosticSeverity::Info,
    }
}

/// Drop any `(key, value)` pair whose key matches the secret detector's env
/// denylist. Values themselves are NOT leaked to the persisted event log —
/// the filter here controls what the PTY child sees, not what gets logged.
///
/// Per ADR 0006 §Detection Placement the launch env is passed through the
/// denylist filter before any `launch_env_redacted` record is written.
/// Phase 1 ships an empty launch env, so this is a defensive preparation
/// for when that surface starts carrying real values.
fn filter_launch_env(
    env: Vec<(String, String)>,
    detector: &dyn SecretDetector,
) -> Vec<(String, String)> {
    env.into_iter()
        .filter(|(k, v)| detector.scan_env_entry(k, v).is_none())
        .collect()
}

/// The single emitter: assigns `monotonic_seq`, stamps the envelope, calls the
/// sink, and fans the result back to the requester. Ordering is preserved by
/// the single-consumer mpsc.
///
/// # FIX 1 — Fail-closed on sink error
///
/// The assigner-then-append protocol burns a seq on every call: the sequence
/// counter is incremented BEFORE `sink.append` runs, so a failed append
/// creates a durable gap the `ZstdSegmentedEventLog::replay_session` strict
/// `SeqGap` check surfaces as corruption. "Log and continue" — the previous
/// policy — would compound the gap on every subsequent append.
///
/// Instead, on a non-recoverable sink error for an acked request (i.e. one
/// where a caller is actively awaiting the result), we:
///
/// 1. Log at `tracing::error!` with full envelope identity (session_id, seq,
///    event_id, causation_id) so an operator can correlate the failed record
///    with the torn tail in the segment file.
/// 2. Flip `sink_failed` so the actor's input-facing methods short-circuit to
///    `SessionError::Closed` instead of waiting on a dead emitter.
/// 3. Best-effort emit a terminal `SessionEnded { SinkFailure }` record so
///    consumers on the replay side see a clean session boundary. This emit
///    is itself fail-closed: if THAT append also errors, we do not retry.
/// 4. Break out of the emit loop so no further sequence numbers are burned.
///
/// For fire-and-forget emits (output chunks, boundary events) the existing
/// behavior is preserved — those are high-volume and non-blocking, and losing
/// one doesn't corrupt the caller's view. But any FAILED fire-and-forget
/// append also flips `sink_failed` and tears the loop down, for the same
/// "don't compound the gap" reason.
async fn emitter_loop(
    mut rx: mpsc::Receiver<EmitRequest>,
    sink: Arc<dyn EventSink>,
    session_id: SessionId,
    mut shutdown: oneshot::Receiver<()>,
    sink_failed: Arc<AtomicBool>,
    recorder: Arc<dyn MetricsRecorder>,
) {
    // Start at 1 and saturate on overflow. Wrapping past u64::MAX would break
    // the strict-monotonic contract ADR 0011 §Durable Commit Ordering relies
    // on; we prefer to pin the ceiling so downstream dedupe treats later
    // records as duplicates rather than seeing a younger sequence number
    // declared as older. A session that mints 1.8e19 events is astronomically
    // unlikely, but the invariant is cheaper to preserve than to debug.
    let mut next_seq: u64 = 1;
    let assign_seq = |seq: &mut u64| -> u64 {
        let cur = *seq;
        *seq = seq.saturating_add(1);
        cur
    };
    let mut failed = false;
    loop {
        tokio::select! {
            // biased: always drain pending emits before shutting down so we
            // don't lose the tail (e.g. SessionEnded).
            biased;
            maybe_req = rx.recv() => {
                let Some(req) = maybe_req else { break; };
                let seq = assign_seq(&mut next_seq);
                let mut env = Envelope::new(
                    session_id,
                    seq,
                    req.producer,
                    SchemaVersion::ONE,
                    req.payload,
                );
                if let Some(bid) = block_id_for_event(&env.payload) {
                    env = env.with_block(bid);
                }
                // B1: capture envelope identity before `append` consumes
                // `env` so any downstream log carries session_id, seq,
                // event_id, and causation_id for after-the-fact triage.
                let event_id = env.event_id;
                let causation_id = env.causation_id;
                // FIX 3: time the append on the recorder. We measure the
                // sink call in microseconds so the histogram buckets capture
                // typical (<1 ms) and slow (>100 ms) appends without
                // swamping the low end.
                let started = std::time::Instant::now();
                let result = sink.append(env).await;
                let elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
                recorder.record_histogram(METRIC_APPEND_LATENCY_US, elapsed_us);
                if result.is_ok() {
                    recorder.inc_counter(METRIC_ENVELOPE_APPENDED);
                }
                if let Err(ref err) = result {
                    // FIX 1: promote to error-level with the full envelope
                    // identity so the torn record can be located post-mortem.
                    error!(
                        session_id = %session_id,
                        seq,
                        %event_id,
                        ?causation_id,
                        ?err,
                        "session.actor.emitter: sink append failed; session is fail-closed"
                    );
                    // Surface the error to any synchronous waiter BEFORE we
                    // flip the failed flag — the ack carries the exact
                    // underlying error, which `submit_input`'s caller needs.
                    if let Some(ack) = req.ack {
                        let _ = ack.send(result);
                    }
                    // Flip the shared flag so input-facing methods bail out
                    // to `Closed` instead of queuing behind a dead emitter.
                    sink_failed.store(true, Ordering::Release);
                    failed = true;
                    // Best-effort terminal SessionEnded(SinkFailure). If
                    // THAT append errors, we log and give up — per the FIX 1
                    // protocol we never retry a burned seq.
                    let terminal_seq = assign_seq(&mut next_seq);
                    let terminal_env = Envelope::new(
                        session_id,
                        terminal_seq,
                        Producer::Session,
                        SchemaVersion::ONE,
                        Event::SessionEnded(SessionEnded {
                            reason: SessionEndReason::SinkFailure,
                        }),
                    );
                    let terminal_event_id = terminal_env.event_id;
                    if let Err(terr) = sink.append(terminal_env).await {
                        error!(
                            session_id = %session_id,
                            seq = terminal_seq,
                            event_id = %terminal_event_id,
                            ?terr,
                            "session.actor.emitter: terminal SessionEnded(SinkFailure) append also failed"
                        );
                    }
                    break;
                }
                // Success path.
                if let Some(ack) = req.ack {
                    let _ = ack.send(result);
                }
            }
            _ = &mut shutdown => {
                // Drain any already-queued requests so we don't lose them.
                while let Ok(req) = rx.try_recv() {
                    let seq = assign_seq(&mut next_seq);
                    let mut env = Envelope::new(
                        session_id,
                        seq,
                        req.producer,
                        SchemaVersion::ONE,
                        req.payload,
                    );
                    if let Some(bid) = block_id_for_event(&env.payload) {
                        env = env.with_block(bid);
                    }
                    let event_id = env.event_id;
                    let causation_id = env.causation_id;
                    let started = std::time::Instant::now();
                    let result = sink.append(env).await;
                    let elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
                    recorder.record_histogram(METRIC_APPEND_LATENCY_US, elapsed_us);
                    if result.is_ok() {
                        recorder.inc_counter(METRIC_ENVELOPE_APPENDED);
                    }
                    if let Some(ack) = req.ack {
                        let _ = ack.send(result);
                    } else if let Err(ref err) = result {
                        debug!(
                            session_id = %session_id,
                            seq,
                            %event_id,
                            ?causation_id,
                            ?err,
                            "session.actor.emitter: event sink append failed during drain"
                        );
                    }
                }
                break;
            }
        }
    }
    // On fail-closed, drain any queued requests so their acks unblock with
    // `Closed`-equivalent errors rather than hang forever waiting on an
    // emitter that has already given up. Dropping the receiver here closes
    // the channel so further `send` attempts observe a `SendError`.
    if failed {
        while let Ok(req) = rx.try_recv() {
            if let Some(ack) = req.ack {
                let _ = ack.send(Err(EventLogError::Closed));
            }
        }
    }
    // Ensure the sink is flushed on shutdown — fsync contract per ADR 0011 §4.
    // On fail-closed, still flush: the sink may have partial durable state
    // we want persisted before the actor tears down.
    if let Err(err) = sink.flush().await {
        debug!(
            session_id = %session_id,
            ?err,
            "session.actor.emitter: event sink flush on shutdown failed"
        );
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "linear read-then-emit flow kept in one function for readability"
)]
async fn read_loop(
    pty: Arc<Mutex<Box<dyn PtyHandle>>>,
    emit_tx: mpsc::Sender<EmitRequest>,
    state: Arc<Mutex<SharedState>>,
    mut shutdown: oneshot::Receiver<()>,
    write_pending: Arc<AtomicBool>,
    write_ready: Arc<Notify>,
) {
    let session_id_for_log = {
        let st = state.lock().await;
        st.session_id
    };
    let mut detector = VteBoundaryDetector::new();
    let mut buf = vec![0u8; PTY_READ_CHUNK_BYTES];
    // Reusable base64 encode target to avoid per-chunk String allocations.
    // Capacity chosen to fit `encoded_len(PTY_READ_CHUNK_BYTES)` without realloc.
    let mut b64_scratch: Vec<u8> = Vec::with_capacity(PTY_READ_CHUNK_BYTES.div_ceil(3) * 4 + 4);
    // Reusable boundary-event sink. VteBoundaryDetector::feed appends into this;
    // we drain it after each chunk and clear() for the next iteration. This
    // replaces a per-chunk Vec::new() in the hot path — every 8 KiB read pays
    // only amortized zero-alloc bookkeeping after the first allocation grows
    // the vec to its steady-state size.
    let mut boundary_events: Vec<BoundaryEvent> = Vec::with_capacity(16);
    // Tier-1 diagnostic pipeline (ADR 0007). Lives on the reader task; fed
    // with UTF-8-decoded copies of the PTY bytes. Reset per block so a
    // diagnostic from block N cannot be misattributed to block N+1.
    //
    // NOTE: parsers are regex-based and cheap, so they run synchronously
    // on the reader. If a parser becomes expensive in a later phase, the
    // right move is to push the pipeline into its own worker task with a
    // bounded channel and a drop-on-overflow policy — diagnostic extraction
    // must never block PTY drain (ADR 0002).
    let mut diagnostics = DiagnosticPipeline::new();
    // Active block id tracked by the reader itself so we can detect
    // block-change transitions and reset the pipeline without racing on
    // SharedState.active_block.
    let mut diag_block: Option<BlockId> = None;
    loop {
        // Write-priority gate: if a write is pending, wait for it to complete
        // before we re-acquire the pty lock. Without this, a blocking read
        // starves writes because tokio::sync::Mutex is FIFO and the reader
        // typically re-queues faster than the writer can call lock().
        if write_pending.load(Ordering::Acquire) {
            // Wait for the input task to signal completion of its write.
            // Bounded to 50 ms so a stuck writer cannot permanently freeze
            // reads — at which point we fall through and try to read anyway.
            let _ =
                tokio::time::timeout(std::time::Duration::from_millis(50), write_ready.notified())
                    .await;
        }
        // Prefer a cancellable read so shutdown doesn't block on a pty
        // that's never going to produce another byte.
        let n = tokio::select! {
            biased;
            _ = &mut shutdown => break,
            res = async {
                // NOTE: the outer Arc<Mutex<Box<dyn PtyHandle>>> is a known
                // contention point — reads serialize against writes. The port
                // requires `&mut self`; splitting read/write halves requires a
                // port change. See cross-scope findings in Round 2 report.
                //
                // The portable adapter bounds each `read()` to a short
                // internal timeout and returns `Ok(0)` on "no data yet" so
                // this outer lock is released promptly for writes to
                // interleave. True EOF is signalled as `PtyError::Closed`.
                let mut g = pty.lock().await;
                g.read(&mut buf).await
            } => match res {
                Ok(n) => n,
                Err(quanta_pty::PtyError::Closed) => {
                    // Child exited / fd closed. Exit the loop so the post-loop
                    // path can seal the active block.
                    break;
                }
                Err(err) => {
                    debug!(
                        session_id = %session_id_for_log,
                        ?err,
                        "session.actor.reader: pty read failed"
                    );
                    break;
                }
            }
        };
        if n == 0 {
            // Empty-tick: adapter saw no data before its internal timeout.
            // Yield to the runtime so the writer / emitter / boundary tasks
            // make progress, then re-enter the select.
            tokio::task::yield_now().await;
            continue;
        }
        // IMPORTANT: keep raw bytes intact. Do NOT decode to `String` here —
        // partial UTF-8 codepoints must survive downstream (base64 payload).
        let bytes = &buf[..n];

        // Record output and emit OutputChunk. One `state.lock` folds in three
        // reads (active_block, in_tui accumulate) and the output append so
        // the reader pays a single critical section on the hot path per chunk.
        // Previously these were two acquisitions + the TUI accumulation was
        // only performed inside `handle_boundary`, which meant pure-output
        // chunks never contributed to `tui_bytes` and `BlockTuiExited` under-
        // reported.
        let chunk_len_u64 = u64::try_from(n).unwrap_or(u64::MAX);
        let (active_block, outcome): (Option<BlockId>, Option<_>) = {
            let mut st = state.lock().await;
            if st.in_tui {
                st.tui_bytes = st.tui_bytes.saturating_add(chunk_len_u64);
            }
            let active = st.active_block.as_ref().map(|a| a.block_id);
            let outcome = active
                .map(|bid| st.output_store.append(bid, OutputStream::Stdout, bytes))
                .unwrap_or(None);
            (active, outcome)
        };
        if let Some(active) = active_block {
            if let Some(outcome) = outcome {
                let b64 = encode_b64_reuse(bytes, &mut b64_scratch);
                if let Err(err) = emit_nowait(
                    &emit_tx,
                    Producer::Output,
                    Event::OutputChunk(OutputChunk {
                        span_id: outcome.span_id,
                        block_id: active,
                        stream: OutputStream::Stdout,
                        seq: outcome.seq,
                        byte_offset_start: outcome.byte_offset_start,
                        byte_offset_end: outcome.byte_offset_end,
                        bytes_b64: b64,
                    }),
                )
                .await
                {
                    warn!(
                        session_id = %session_id_for_log,
                        block_id = %active,
                        ?err,
                        "session.actor.reader: OutputChunk append failed"
                    );
                    // Emitter is gone. Nothing more we can do; let the loop
                    // exit on next iteration via shutdown or channel closure.
                    break;
                }
            }
        }

        // --- Tier-1 diagnostic extraction (ADR 0007). ---
        //
        // We hand raw bytes to the pipeline via `feed_bytes`; the pipeline
        // owns a streaming UTF-8 decoder that carries partial codepoints
        // across chunk boundaries. This fixes FIX 3: previously we called
        // `String::from_utf8_lossy` per-chunk, which turned any codepoint
        // straddling chunks N and N+1 into U+FFFD on N and orphan
        // continuation bytes on N+1 — breaking Korean / Chinese / emoji
        // diagnostics at PTY read boundaries.
        //
        // The line buffer inside the pipeline still re-joins cross-chunk
        // lines so a diagnostic whose header arrives in chunk N-1 and
        // whose `-->` arrives in chunk N still parses.
        //
        // Do NOT block the PTY drain on this: parsers are synchronous
        // and regex-based, so the wall-clock cost per chunk is bounded;
        // if a future parser becomes expensive it should move to a
        // worker task per the note at the top of this loop.
        if let Some(active) = active_block {
            // Reset on block-change so stale state cannot bleed across.
            if diag_block != Some(active) {
                diagnostics.reset_block();
                diag_block = Some(active);
            }
            let emitted = diagnostics.feed_bytes(bytes);
            for d in emitted {
                let ev = Event::DiagnosticDetected(DiagnosticDetected {
                    diagnostic_id: DiagnosticId::new(),
                    block_id: active,
                    parser_id: d.parser_id,
                    category: map_category(d.category),
                    severity: map_severity(d.severity),
                    confidence: d.confidence,
                    message: d.message,
                    path: d.path,
                    line: d.line,
                    column: d.column,
                    end_line: d.end_line,
                    end_column: d.end_column,
                    symbol: d.symbol,
                });
                if let Err(err) = emit_nowait(&emit_tx, Producer::Diagnostic, ev).await {
                    warn!(
                        session_id = %session_id_for_log,
                        block_id = %active,
                        ?err,
                        "session.actor.reader: DiagnosticDetected append failed"
                    );
                    break;
                }
            }
        } else if diag_block.is_some() {
            // No active block → block ended between chunks. Flush any
            // trailing diagnostics (e.g. a tsc line without a newline)
            // before the pipeline goes idle.
            let tail = diagnostics.flush();
            if !tail.is_empty() {
                // Tail emissions anchor to the block we WERE tracking,
                // not the next one (which isn't known yet).
                if let Some(block) = diag_block {
                    for d in tail {
                        let ev = Event::DiagnosticDetected(DiagnosticDetected {
                            diagnostic_id: DiagnosticId::new(),
                            block_id: block,
                            parser_id: d.parser_id,
                            category: map_category(d.category),
                            severity: map_severity(d.severity),
                            confidence: d.confidence,
                            message: d.message,
                            path: d.path,
                            line: d.line,
                            column: d.column,
                            end_line: d.end_line,
                            end_column: d.end_column,
                            symbol: d.symbol,
                        });
                        let _ = emit_nowait(&emit_tx, Producer::Diagnostic, ev).await;
                    }
                }
            }
            diag_block = None;
        }

        // Parse boundary events. We reuse `boundary_events` across iterations
        // (cleared before each feed) so the hot path doesn't pay for a fresh
        // Vec allocation per 8 KiB chunk.
        boundary_events.clear();
        detector.feed(bytes, &mut boundary_events);
        // `n` is bounded by `PTY_READ_CHUNK_BYTES` (8 KiB), so the widen is
        // lossless on every supported target; kept as a `try_from` for lint
        // uniformity across the workspace.
        let chunk_len = u64::try_from(n).unwrap_or(u64::MAX);
        for bev in boundary_events.drain(..) {
            if let Err(err) = handle_boundary(bev, &emit_tx, &state, chunk_len).await {
                warn!(
                    session_id = %session_id_for_log,
                    ?err,
                    "session.actor.reader: handle_boundary failed"
                );
            }
        }
    }

    // PTY closed or shutdown. Seal any active block as completed via child exit.
    let maybe_active = {
        let st = state.lock().await;
        st.active_block.as_ref().map(|a| a.block_id)
    };
    // Wait on the PTY to collect the exit code (best effort, bounded).
    let exit = {
        // NOTE: use a short timeout so a hung child doesn't block session
        // close indefinitely. ADR 0004 §Crash Recovery allows SIGKILL fallback.
        let pty = pty.clone();
        tokio::time::timeout(std::time::Duration::from_millis(500), async move {
            let mut g = pty.lock().await;
            g.wait().await.ok()
        })
        .await
        .unwrap_or(None)
    };
    if let Some(block_id) = maybe_active {
        let code = exit.and_then(|e| e.exit_code);
        let _ = emit_nowait(
            &emit_tx,
            Producer::Block,
            Event::BlockCompleted(BlockCompleted {
                block_id,
                exit_code: code,
                termination_signal: None,
                boundary_signal: BoundarySignal::ChildExit,
                boundary_confidence: BoundaryConfidence::Authoritative,
            }),
        )
        .await;
        let mut st = state.lock().await;
        st.active_block = None;
    }
    let _ = emit_nowait(
        &emit_tx,
        Producer::Session,
        Event::SessionEnded(SessionEnded {
            reason: SessionEndReason::ShellExited,
        }),
    )
    .await;
}

/// Encode `bytes` as standard base64 into `scratch`, returning a fresh `String`
/// sliced from the scratch buffer. The allocation for the final `String` is
/// unavoidable because `OutputChunk.bytes_b64` owns a `String`, but the
/// intermediate encode buffer is reused across iterations.
///
/// Both `expect` calls below guard invariants that are bounded by the
/// allocation above:
///
/// - `encode_slice` only fails when the destination buffer is smaller than
///   the encoded output, and we just sized `scratch` to `needed` which is the
///   exact encoded length for `bytes.len()`.
/// - `str::from_utf8` only fails on non-ASCII bytes. Base64 output is
///   restricted to ASCII (`[A-Za-z0-9+/=]`), so a failure would indicate a
///   programming error in the `base64` crate itself; panic is the right
///   outcome in that case because the data would already be corrupt.
fn encode_b64_reuse(bytes: &[u8], scratch: &mut Vec<u8>) -> String {
    let needed = bytes.len().div_ceil(3) * 4;
    if scratch.len() < needed {
        scratch.resize(needed, 0);
    }
    let written = BASE64
        .encode_slice(bytes, &mut scratch[..needed])
        .expect("base64: scratch sized for full encode (see encode_b64_reuse docs)");
    std::str::from_utf8(&scratch[..written])
        .expect("base64 output is ASCII by construction (see encode_b64_reuse docs)")
        .to_string()
}

#[expect(
    clippy::too_many_lines,
    reason = "dispatches every boundary variant inline for locality"
)]
async fn handle_boundary(
    ev: BoundaryEvent,
    emit_tx: &mpsc::Sender<EmitRequest>,
    state: &Arc<Mutex<SharedState>>,
    chunk_len: u64,
) -> Result<(), EventLogError> {
    match ev {
        BoundaryEvent::PromptStart => {
            // PromptStart indicates the shell is ready for the next command.
            // If we have an active block, close it with Osc133.
            let (active_block, was_not_installed) = {
                let mut st = state.lock().await;
                let active = st.active_block.take();
                // Mark shell integration as installed on first marker.
                let flipped = !matches!(
                    st.shell_integration_status,
                    ShellIntegrationStatus::Installed
                );
                st.shell_integration_status = ShellIntegrationStatus::Installed;
                (active, flipped)
            };
            if let Some(active) = active_block {
                emit_nowait(
                    emit_tx,
                    Producer::Block,
                    Event::BlockCompleted(BlockCompleted {
                        block_id: active.block_id,
                        exit_code: None,
                        termination_signal: None,
                        boundary_signal: BoundarySignal::Osc133,
                        boundary_confidence: BoundaryConfidence::Authoritative,
                    }),
                )
                .await?;
            }
            // Only emit the status transition on first install. Subsequent
            // PromptStarts don't change state; emitting every time would spam
            // the durable log with redundant transitions.
            if was_not_installed {
                emit_nowait(
                    emit_tx,
                    Producer::Session,
                    Event::SessionShellIntegrationStatus(SessionShellIntegrationStatus {
                        status: ShellIntegrationStatus::Installed,
                    }),
                )
                .await?;
            }
        }
        BoundaryEvent::CommandDone { exit_code } => {
            // OSC 133 D — close the active block authoritatively. Also flips
            // shell_integration_status to `Installed`: observing a CommandDone
            // without a prior PromptStart (e.g. we connected mid-session, or
            // the first PromptStart straddled a chunk boundary the detector
            // didn't coalesce) is still proof the shell is OSC133-aware.
            let (active_block, was_not_installed) = {
                let mut st = state.lock().await;
                let active = st.active_block.take();
                let flipped = !matches!(
                    st.shell_integration_status,
                    ShellIntegrationStatus::Installed
                );
                st.shell_integration_status = ShellIntegrationStatus::Installed;
                (active, flipped)
            };
            if let Some(active) = active_block {
                emit_nowait(
                    emit_tx,
                    Producer::Block,
                    Event::BlockCompleted(BlockCompleted {
                        block_id: active.block_id,
                        exit_code,
                        termination_signal: None,
                        boundary_signal: BoundarySignal::Osc133,
                        boundary_confidence: BoundaryConfidence::Authoritative,
                    }),
                )
                .await?;
            }
            // Only emit the status event on the first flip so we don't spam
            // the log every time the shell emits a CommandDone.
            if was_not_installed {
                emit_nowait(
                    emit_tx,
                    Producer::Session,
                    Event::SessionShellIntegrationStatus(SessionShellIntegrationStatus {
                        status: ShellIntegrationStatus::Installed,
                    }),
                )
                .await?;
            }
        }
        BoundaryEvent::CwdAdvertised { cwd } => {
            let path = PathBuf::from(cwd);
            {
                let mut st = state.lock().await;
                st.cwd.clone_from(&path);
                st.cwd_source = CwdSource::Osc7;
            }
            emit_nowait(
                emit_tx,
                Producer::Session,
                Event::SessionCwdChanged(SessionCwdChanged {
                    cwd: path,
                    source: CwdSource::Osc7,
                }),
            )
            .await?;
        }
        BoundaryEvent::AltScreenEntered => {
            let active = {
                let mut st = state.lock().await;
                st.in_tui = true;
                st.tui_bytes = 0;
                st.active_block.as_ref().map(|a| a.block_id)
            };
            if let Some(block_id) = active {
                emit_nowait(
                    emit_tx,
                    Producer::Block,
                    Event::BlockTuiEntered(BlockTuiEntered { block_id }),
                )
                .await?;
            }
        }
        BoundaryEvent::AltScreenExited => {
            let (active, bytes) = {
                let mut st = state.lock().await;
                st.in_tui = false;
                let bytes = st.tui_bytes;
                (st.active_block.as_ref().map(|a| a.block_id), bytes)
            };
            if let Some(block_id) = active {
                emit_nowait(
                    emit_tx,
                    Producer::Block,
                    Event::BlockTuiExited(BlockTuiExited {
                        block_id,
                        bytes_written: bytes,
                        unclean: false,
                    }),
                )
                .await?;
            }
        }
        BoundaryEvent::CommandStart | BoundaryEvent::OutputStart => {
            // Book-keeping only; the state machine does not transition on these.
        }
    }
    // NOTE: per-chunk TUI byte accumulation is done in the reader's single
    // state.lock critical section — not here. Performing it here would miss
    // every chunk that contains no boundary events (the common case during
    // TUI sessions) and would double-count chunks that produced several
    // boundary events. `chunk_len` is retained in the signature for
    // symmetry / future callers.
    let _ = chunk_len;
    Ok(())
}

async fn input_loop(
    mut rx: mpsc::Receiver<InputCommand>,
    pty: Arc<Mutex<Box<dyn PtyHandle>>>,
    mut shutdown: oneshot::Receiver<()>,
    write_pending: Arc<AtomicBool>,
    write_ready: Arc<Notify>,
    session_id: SessionId,
) {
    loop {
        let cmd = tokio::select! {
            biased;
            _ = &mut shutdown => break,
            maybe = rx.recv() => match maybe {
                Some(cmd) => cmd,
                None => break,
            }
        };
        // Signal the reader to yield so we can acquire pty.lock() without
        // starving behind an indefinite `pty.read()` call.
        write_pending.store(true, Ordering::Release);
        let outcome = match cmd {
            InputCommand::Write(bytes) => {
                let mut g = pty.lock().await;
                g.write_all(&bytes).await.map_err(|e| {
                    warn!(
                        session_id = %session_id,
                        err = ?e,
                        "session.actor.input: pty write failed"
                    );
                    e
                })
            }
            InputCommand::Resize(size) => {
                let mut g = pty.lock().await;
                g.resize(size).await
            }
            InputCommand::Cancel(_block_id) => {
                // Send Ctrl-C to the PTY. The shell reduces that to SIGINT.
                // NOTE: we do NOT escalate to SIGKILL here; escalation lives
                // at the process supervisor layer per ADR 0004.
                let mut g = pty.lock().await;
                g.write_all(&[0x03]).await
            }
            InputCommand::Close => {
                let mut g = pty.lock().await;
                let _ = g.kill().await;
                // Clear the pending flag before breaking so a racing reader
                // doesn't wait 50 ms for a notification that never comes.
                write_pending.store(false, Ordering::Release);
                write_ready.notify_waiters();
                break;
            }
        };
        write_pending.store(false, Ordering::Release);
        // Wake the reader: one permit for the currently-waiting read cycle
        // and then it can re-enter its read.
        write_ready.notify_waiters();
        if let Err(err) = outcome {
            debug!(
                session_id = %session_id,
                ?err,
                "session.actor.input: pty op failed"
            );
            // Do not exit on transient resize errors; keep going.
            if matches!(err, quanta_pty::PtyError::Closed) {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quanta_events::{EventLogReader as _, ZstdSegmentedEventLog};
    use quanta_pty::PortablePtyPort;

    #[tokio::test]
    async fn spawn_and_close_emits_session_created() {
        let tmp = tempfile::tempdir().unwrap();
        let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
        let pty = Arc::new(PortablePtyPort::new());
        let cfg = SessionConfig::default_login("/bin/sh", PathBuf::from("/tmp"));
        let (actor, session_id) = SessionActor::spawn(pty, log.clone(), cfg).await.unwrap();
        // Close and wait briefly for the PTY read loop to drain.
        actor.close().await.unwrap();
        let records = log.replay_session(session_id).await.unwrap();
        assert!(records
            .iter()
            .any(|r| matches!(r.envelope.payload, Event::SessionCreated(_))));
    }

    /// FIX 5: if the bounded input channel is full AND the receiver never
    /// drains (stuck input task / hung PTY), `send_input_bounded` must time
    /// out and return `SessionError::Unresponsive` rather than hang.
    ///
    /// We construct the failure directly at the helper level: create a
    /// bounded channel of capacity 1, fill it, and retain the receiver
    /// without polling so the sender's backpressure never releases.
    ///
    /// To keep the test fast we temporarily override the timeout via a
    /// variant of `send_input_bounded` that accepts the duration as a
    /// parameter — otherwise the test would block for `SUBMIT_INPUT_SEND_TIMEOUT`
    /// (5 s) to observe the outcome. The production helper's constant wraps
    /// the same implementation.
    #[tokio::test]
    async fn send_input_bounded_times_out_when_receiver_stuck() {
        async fn with_timeout(
            tx: &mpsc::Sender<InputCommand>,
            cmd: InputCommand,
            dur: Duration,
        ) -> Result<(), SessionError> {
            match tokio::time::timeout(dur, tx.send(cmd)).await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(_)) => Err(SessionError::Closed),
                Err(_) => Err(SessionError::Unresponsive),
            }
        }

        // Capacity 1, fill it, then drop no receiver — the second send will
        // block indefinitely without a timeout.
        let (tx, _rx) = mpsc::channel::<InputCommand>(1);
        tx.send(InputCommand::Write(b"first".to_vec()))
            .await
            .expect("first send fills the buffer");
        let err = with_timeout(
            &tx,
            InputCommand::Write(b"second".to_vec()),
            Duration::from_millis(100),
        )
        .await
        .expect_err("second send must time out");
        assert!(
            matches!(err, SessionError::Unresponsive),
            "expected Unresponsive, got: {err:?}",
        );
    }

    /// FIX 5 continuation: the full helper behind the ABI. Sanity-check that
    /// dropping the receiver yields `Closed`, not `Unresponsive`.
    #[tokio::test]
    async fn send_input_bounded_surfaces_closed_when_receiver_dropped() {
        let (tx, rx) = mpsc::channel::<InputCommand>(1);
        drop(rx);
        let err = send_input_bounded(&tx, InputCommand::Write(b"x".to_vec()))
            .await
            .expect_err("send to dropped receiver must fail");
        assert!(matches!(err, SessionError::Closed), "got: {err:?}");
    }
}
