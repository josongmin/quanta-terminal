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

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use quanta_block::{BoundaryEvent, VteBoundaryDetector};
use quanta_events::{EventLogError, EventSink};
use quanta_output::OutputStore;
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{
    BlockCompleted, BlockCreated, BlockStarted, BlockTuiEntered, BlockTuiExited,
    BoundaryConfidence, BoundarySignal, CwdSource, Event, InputSubmitted, OutputChunk,
    OutputStream, SessionCreated, SessionCwdChanged, SessionEndReason, SessionEnded,
    SessionShellIntegrationStatus, ShellIntegrationStatus,
};
use quanta_proto::ids::{BlockId, EventId, SessionId};
use quanta_pty::{PtyHandle, PtyPort, PtySize, PtySpec};
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use crate::domain::{InputSubmission, SessionConfig, SessionSnapshot};
use crate::ports::{SessionError, SessionHandle};

// NOTE: channel bounds tuned for a desktop workload; full buffers apply
// backpressure to producers rather than growing memory unbounded. See ADR 0011
// §Backpressure — the sink IS durable, so any delay here is bounded by fsync.
const INPUT_CHANNEL_CAPACITY: usize = 256;
const EMIT_CHANNEL_CAPACITY: usize = 1024;
// NOTE: 8 KiB chunk is a compromise between span fragmentation and latency.
// Increase to 64 KiB only if the serializer/sink becomes the bottleneck.
const PTY_READ_CHUNK_BYTES: usize = 8 * 1024;

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
    #[expect(
        clippy::too_many_lines,
        reason = "inline wiring of 3 tasks + shutdown fanout kept local for locality"
    )]
    pub async fn spawn(
        pty_port: Arc<dyn PtyPort>,
        sink: Arc<dyn EventSink>,
        config: SessionConfig,
    ) -> Result<(Self, SessionId), SessionError> {
        let session_id = SessionId::new();
        let spec = PtySpec {
            program: config.shell.clone(),
            args: config.args.clone(),
            cwd: Some(config.cwd.clone()),
            env: Vec::new(),
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

        // Spawn emitter FIRST so SessionCreated can go through it.
        let emitter_task: JoinHandle<()> = {
            let sink = sink.clone();
            let session_id_for_task = session_id;
            tokio::spawn(async move {
                emitter_loop(emit_rx, sink, session_id_for_task, emitter_stop_rx).await;
            })
        };

        let actor = Self {
            state: state.clone(),
            emitter_tx: emit_tx.clone(),
            input_tx: input_tx.clone(),
            session_id,
            shutdown_tx: Arc::new(Mutex::new(Some(shutdown_tx))),
            tasks: Arc::new(Mutex::new(Vec::new())),
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
        let input_task: JoinHandle<()> = tokio::spawn(async move {
            input_loop(
                input_rx,
                input_pty,
                input_stop_rx,
                input_write_pending,
                input_write_ready,
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

        Ok((actor, session_id))
    }
}

#[async_trait]
impl SessionHandle for SessionActor {
    async fn submit_input(&self, input: InputSubmission) -> Result<Option<BlockId>, SessionError> {
        emit(
            &self.emitter_tx,
            &self.state,
            Producer::Session,
            Event::InputSubmitted(InputSubmitted {
                text: input.text.clone(),
                input_kind: input.kind,
            }),
        )
        .await?;

        if !input.submit {
            // Passthrough: write raw bytes, no block. `send` applies backpressure
            // if the pty input task is behind (bounded channel).
            self.input_tx
                .send(InputCommand::Write(input.text.into_bytes()))
                .await
                .map_err(|_| SessionError::Closed)?;
            return Ok(None);
        }

        // Create a new block.
        let block_id = BlockId::new();
        let (ordinal, cwd, cwd_source) = {
            let mut st = self.state.lock().await;
            let ord = st.next_ordinal;
            st.next_ordinal += 1;
            (ord, st.cwd.clone(), st.cwd_source)
        };
        emit(
            &self.emitter_tx,
            &self.state,
            Producer::Block,
            Event::BlockCreated(BlockCreated {
                block_id,
                ordinal,
                input_text: input.text.clone(),
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
                input_text: input.text.clone(),
                saw_osc133_d: false,
            });
        }
        // Write command bytes + CR so the shell executes.
        let mut bytes = input.text.into_bytes();
        bytes.push(b'\n');
        self.input_tx
            .send(InputCommand::Write(bytes))
            .await
            .map_err(|_| SessionError::Closed)?;
        Ok(Some(block_id))
    }

    async fn resize(&self, size: PtySize) -> Result<(), SessionError> {
        self.input_tx
            .send(InputCommand::Resize(size))
            .await
            .map_err(|_| SessionError::Closed)?;
        Ok(())
    }

    async fn cancel_block(&self, block_id: BlockId) -> Result<(), SessionError> {
        self.input_tx
            .send(InputCommand::Cancel(block_id))
            .await
            .map_err(|_| SessionError::Closed)?;
        Ok(())
    }

    async fn close(&self) -> Result<(), SessionError> {
        // Best effort: ask the input task to kill the child.
        let _ = self.input_tx.send(InputCommand::Close).await;
        // Signal all tasks to stop.
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }
        // Drain and join tasks so we don't leak orphans past session close.
        // NOTE: we do NOT await here with a hard timeout; callers that need a
        // bounded close should apply their own `tokio::time::timeout`. Tasks
        // stop promptly because the shutdown oneshot fires and channels close.
        let handles: Vec<_> = std::mem::take(&mut *self.tasks.lock().await);
        for h in handles {
            let _ = h.await;
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
        _ => None,
    }
}

fn is_compound(text: &str) -> bool {
    text.contains("&&") || text.contains("||") || text.contains(';') || text.contains('|')
}

/// The single emitter: assigns `monotonic_seq`, stamps the envelope, calls the
/// sink, and fans the result back to the requester. Ordering is preserved by
/// the single-consumer mpsc.
async fn emitter_loop(
    mut rx: mpsc::Receiver<EmitRequest>,
    sink: Arc<dyn EventSink>,
    session_id: SessionId,
    mut shutdown: oneshot::Receiver<()>,
) {
    let mut next_seq: u64 = 1;
    loop {
        tokio::select! {
            // biased: always drain pending emits before shutting down so we
            // don't lose the tail (e.g. SessionEnded).
            biased;
            maybe_req = rx.recv() => {
                let Some(req) = maybe_req else { break; };
                let seq = next_seq;
                next_seq += 1;
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
                let result = sink.append(env).await;
                if let Some(ack) = req.ack {
                    let _ = ack.send(result);
                } else if let Err(ref err) = result {
                    // Fire-and-forget emits (output chunks, boundary events):
                    // surface failures at debug level; the session survives.
                    debug!(?err, "event sink append failed");
                }
            }
            _ = &mut shutdown => {
                // Drain any already-queued requests so we don't lose them.
                while let Ok(req) = rx.try_recv() {
                    let seq = next_seq;
                    next_seq += 1;
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
                    let result = sink.append(env).await;
                    if let Some(ack) = req.ack {
                        let _ = ack.send(result);
                    }
                }
                break;
            }
        }
    }
    // Ensure the sink is flushed on shutdown — fsync contract per ADR 0011 §4.
    if let Err(err) = sink.flush().await {
        debug!(?err, "event sink flush on shutdown failed");
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
    let mut detector = VteBoundaryDetector::new();
    let mut buf = vec![0u8; PTY_READ_CHUNK_BYTES];
    // Reusable base64 encode target to avoid per-chunk String allocations.
    // Capacity chosen to fit `encoded_len(PTY_READ_CHUNK_BYTES)` without realloc.
    let mut b64_scratch: Vec<u8> = Vec::with_capacity(PTY_READ_CHUNK_BYTES.div_ceil(3) * 4 + 4);
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
                    debug!(?err, "pty read error");
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

        // Record output and emit OutputChunk.
        let active_block: Option<BlockId> = {
            let st = state.lock().await;
            st.active_block.as_ref().map(|a| a.block_id)
        };
        if let Some(active) = active_block {
            let outcome = {
                let mut st = state.lock().await;
                st.output_store.append(active, OutputStream::Stdout, bytes)
            };
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
                    warn!(?err, "append OutputChunk failed");
                    // Emitter is gone. Nothing more we can do; let the loop
                    // exit on next iteration via shutdown or channel closure.
                    break;
                }
            }
        }

        // Parse boundary events.
        let mut events: Vec<BoundaryEvent> = Vec::new();
        detector.feed(bytes, &mut events);
        for bev in events {
            if let Err(err) = handle_boundary(bev, &emit_tx, &state, n as u64).await {
                warn!(?err, "handle_boundary failed");
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
fn encode_b64_reuse(bytes: &[u8], scratch: &mut Vec<u8>) -> String {
    let needed = bytes.len().div_ceil(3) * 4;
    if scratch.len() < needed {
        scratch.resize(needed, 0);
    }
    let written = BASE64
        .encode_slice(bytes, &mut scratch[..needed])
        .expect("scratch sized for full encode");
    // Base64 output is always ASCII; construction via from_utf8_lossy would be
    // redundant, but we use the checked path for defense.
    std::str::from_utf8(&scratch[..written])
        .expect("base64 output is ASCII")
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
            let active_block = {
                let mut st = state.lock().await;
                let active = st.active_block.take();
                // Mark shell integration as installed on first marker.
                st.shell_integration_status = ShellIntegrationStatus::Installed;
                active
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
            emit_nowait(
                emit_tx,
                Producer::Session,
                Event::SessionShellIntegrationStatus(SessionShellIntegrationStatus {
                    status: ShellIntegrationStatus::Installed,
                }),
            )
            .await?;
        }
        BoundaryEvent::CommandDone { exit_code } => {
            // OSC 133 D — close the active block authoritatively.
            let active_block = {
                let mut st = state.lock().await;
                st.active_block.take()
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
    // Accumulate TUI bytes for BlockTuiExited.
    {
        let mut st = state.lock().await;
        if st.in_tui {
            st.tui_bytes = st.tui_bytes.saturating_add(chunk_len);
        }
    }
    Ok(())
}

async fn input_loop(
    mut rx: mpsc::Receiver<InputCommand>,
    pty: Arc<Mutex<Box<dyn PtyHandle>>>,
    mut shutdown: oneshot::Receiver<()>,
    write_pending: Arc<AtomicBool>,
    write_ready: Arc<Notify>,
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
                    warn!(?e, "pty write failed");
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
            debug!(?err, "pty op failed");
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
}
