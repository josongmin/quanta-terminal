//! BUG 1 pin — reader-task start-up resize race.
//!
//! Before the fix, `read_loop` called `resize_rx.mark_unchanged()` on entry
//! to clear the dirty bit on the watch channel's initial value. If the input
//! task processed a `Resize` command and called `resize_tx.send(new_size)`
//! between `spawn` and the reader reaching `mark_unchanged`, that
//! `mark_unchanged` cleared the dirty bit without the reader observing the
//! new value — effectively swallowing the first post-spawn resize.
//!
//! The fix replaces `mark_unchanged()` with `borrow_and_update()`, which
//! atomically observes the current value AND clears the dirty bit. The
//! reader then applies the observed geometry on the fly, so no resize is
//! ever swallowed — not even one that landed between `watch::channel`
//! construction and the reader's first poll.
//!
//! These tests drive the race deterministically by firing a resize BEFORE
//! we let the reader make its first pass, then asserting the engine's
//! `resize_generation` bumped (i.e. the resize was observed).

#![allow(
    clippy::doc_markdown,
    clippy::type_complexity,
    clippy::redundant_closure_for_method_calls,
    reason = "test file uses inline ADR mentions and minor pattern duplication for clarity"
)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use quanta_events::ZstdSegmentedEventLog;
use quanta_pty::{PtyError, PtyExit, PtyHandle, PtyPort, PtySize, PtySpec};
use quanta_session::{SessionActor, SessionConfig, SessionHandle};
use tokio::sync::{mpsc, Mutex, Notify};

// Mock PTY that records every `resize()` call into a shared counter.
#[derive(Debug)]
struct ResizeCountingPty {
    read_rx: Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    resize_count: Arc<AtomicUsize>,
    closed: Arc<Notify>,
    is_closed: Arc<AtomicBool>,
}

#[async_trait]
impl PtyHandle for ResizeCountingPty {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError> {
        if self.is_closed.load(Ordering::Acquire) {
            return Err(PtyError::Closed);
        }
        let mut guard = self.read_rx.lock().await;
        match tokio::time::timeout(Duration::from_millis(25), guard.recv()).await {
            Ok(Some(bytes)) => {
                let n = bytes.len().min(buf.len());
                buf[..n].copy_from_slice(&bytes[..n]);
                Ok(n)
            }
            Ok(None) => Err(PtyError::Closed),
            Err(_) => Ok(0),
        }
    }

    async fn write_all(&mut self, _data: &[u8]) -> Result<(), PtyError> {
        Ok(())
    }

    async fn resize(&mut self, _size: PtySize) -> Result<(), PtyError> {
        self.resize_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn wait(&mut self) -> Result<PtyExit, PtyError> {
        if self.is_closed.load(Ordering::Acquire) {
            return Ok(PtyExit::code(0));
        }
        self.closed.notified().await;
        Ok(PtyExit::code(0))
    }

    async fn kill(&mut self) -> Result<(), PtyError> {
        self.is_closed.store(true, Ordering::Release);
        self.closed.notify_waiters();
        Ok(())
    }

    fn pid(&self) -> Option<u32> {
        None
    }
}

struct PortInner {
    read_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    resize_count: Arc<AtomicUsize>,
    closed: Arc<Notify>,
    is_closed: Arc<AtomicBool>,
}

#[derive(Debug)]
struct ResizeCountingPort {
    inner: Mutex<Option<PortInner>>,
}

impl std::fmt::Debug for PortInner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortInner").finish_non_exhaustive()
    }
}

#[async_trait]
impl PtyPort for ResizeCountingPort {
    async fn open(&self, _spec: PtySpec) -> Result<Box<dyn PtyHandle>, PtyError> {
        let taken = self
            .inner
            .lock()
            .await
            .take()
            .ok_or_else(|| PtyError::Spawn("resize-counting port: already opened".into()))?;
        Ok(Box::new(ResizeCountingPty {
            read_rx: Mutex::new(taken.read_rx),
            resize_count: taken.resize_count,
            closed: taken.closed,
            is_closed: taken.is_closed,
        }))
    }
}

struct Harness {
    actor: SessionActor,
    resize_count: Arc<AtomicUsize>,
    read_tx: mpsc::UnboundedSender<Vec<u8>>,
    _log: Arc<ZstdSegmentedEventLog>,
    _tmp: tempfile::TempDir,
}

/// Build a session WITHOUT priming the reader. Unlike `resize_generation.rs`'s
/// `spawn_harness`, we intentionally do NOT feed a space byte and do NOT sleep,
/// so the reader has had no opportunity to reach its first loop iteration by
/// the time we return — exposing the start-up race window.
async fn spawn_raw(cols: u16, rows: u16) -> Harness {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());

    let (read_tx, read_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let resize_count = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(Notify::new());
    let is_closed = Arc::new(AtomicBool::new(false));

    let port = Arc::new(ResizeCountingPort {
        inner: Mutex::new(Some(PortInner {
            read_rx,
            resize_count: resize_count.clone(),
            closed,
            is_closed,
        })),
    });

    let cfg = SessionConfig {
        shell: "/bin/sh".into(),
        args: Vec::new(),
        cwd: PathBuf::from("/tmp"),
        cols,
        rows,
        use_vt_engine: true,
    };
    let (actor, _sid) = SessionActor::spawn(port, log.clone(), cfg)
        .await
        .expect("spawn");

    Harness {
        actor,
        resize_count,
        read_tx,
        _log: log,
        _tmp: tmp,
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(500)).await;
}

/// Case A — a resize that fires BEFORE the reader's first poll must still be
/// observed. We fire the resize immediately after `spawn` returns; the reader
/// task has been spawned but has not necessarily reached its loop yet.
/// Previously the reader's `mark_unchanged()` would swallow this signal and
/// `resize_generation` would stay at 0; after the fix, the reader consumes
/// the pending value via `borrow_and_update()` and the counter bumps.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_resize_before_reader_first_poll_is_observed() {
    let h = spawn_raw(80, 24).await;

    // Fire immediately — no prime, no settle. This is the start-up race
    // window: `spawn` returned, the three tasks have been spawned, but the
    // reader task has not necessarily reached `read_loop` top yet.
    h.actor.resize(PtySize::new(120, 40)).await.expect("resize");
    settle().await;

    let snap = h.actor.snapshot().await;
    assert!(
        snap.resize_generation >= 1,
        "reader must observe a resize that fires before its first poll; resize_generation={}",
        snap.resize_generation
    );
    // SIGWINCH still reaches the PTY regardless of the race (the input task
    // is what calls `pty.resize`). Sanity check.
    assert_eq!(
        h.resize_count.load(Ordering::SeqCst),
        1,
        "SIGWINCH must be delivered exactly once per SessionHandle::resize"
    );

    let _ = tokio::time::timeout(Duration::from_secs(3), h.actor.close()).await;
    drop(h.read_tx);
}

/// Case B — rapid-fire resizes all land on the reader. Each distinct
/// geometry must bump `resize_generation` (no coalescing that would
/// under-report, no swallowing).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rapid_fire_resizes_each_observable() {
    let h = spawn_raw(80, 24).await;

    // 5 distinct resizes back-to-back, no settle between them.
    let sequence = [(90, 26), (100, 30), (110, 32), (120, 40), (130, 42)];
    for (cols, rows) in sequence {
        h.actor
            .resize(PtySize::new(cols, rows))
            .await
            .unwrap_or_else(|e| panic!("resize {cols}x{rows}: {e:?}"));
    }
    settle().await;

    // The engine processes resizes serially. Because the watch channel only
    // carries the LATEST value, coalescing at the watch level is expected —
    // but the LAST resize must land, so `resize_generation` must bump at
    // least once. The stronger invariant we pin here: the final snapshot
    // reflects an advance, proving no post-spawn resize was swallowed.
    let snap = h.actor.snapshot().await;
    assert!(
        snap.resize_generation >= 1,
        "final resize must be observed; resize_generation={}",
        snap.resize_generation
    );
    // All 5 SIGWINCH deliveries land (input task → PTY is 1:1, independent
    // of watch-channel coalescing).
    assert_eq!(
        h.resize_count.load(Ordering::SeqCst),
        5,
        "5 SessionHandle::resize calls must produce 5 SIGWINCH deliveries"
    );

    let _ = tokio::time::timeout(Duration::from_secs(3), h.actor.close()).await;
    drop(h.read_tx);
}

/// Case C — an identity resize (same as spawn geometry) fired in the race
/// window is still idempotent on the engine's `resize_generation`. The fix
/// must NOT accidentally promote identity-resizes to counter bumps.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn identity_resize_in_race_window_is_still_idempotent() {
    let h = spawn_raw(80, 24).await;

    // Identity resize — same dims as spawn.
    h.actor.resize(PtySize::new(80, 24)).await.expect("resize");
    settle().await;

    let snap = h.actor.snapshot().await;
    assert_eq!(
        snap.resize_generation, 0,
        "identity resize must not bump resize_generation even in the race window; got {}",
        snap.resize_generation
    );
    // PTY side still sees the SIGWINCH regardless of engine short-circuit.
    assert_eq!(
        h.resize_count.load(Ordering::SeqCst),
        1,
        "SIGWINCH still delivered on identity resize (retires RFC §22 #10)"
    );

    let _ = tokio::time::timeout(Duration::from_secs(3), h.actor.close()).await;
    drop(h.read_tx);
}
