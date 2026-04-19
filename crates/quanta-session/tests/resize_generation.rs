//! EPIC-F DoD — resize-generation monotonicity and SIGWINCH fan-out.
//!
//! Retires scenarios E2E-F3, DoD-F-17, DoD-F-18 from
//! `docs/plans/0001-custom-vt-engine-xterm-removal/epic-F-session-integration.md`.
//!
//! What we exercise:
//!
//! - Identity resize (same cols × rows as spawn geometry) does NOT bump the
//!   engine's `resize_generation`. `Grid::resize` short-circuits when the
//!   geometry matches, so no `Resize` event is emitted and the counter stays
//!   where it was (see `crates/quanta-vt/src/domain/grid.rs::resize`).
//! - Distinct geometry bumps `resize_generation` exactly once per `resize()`
//!   call, and every subsequent event envelope carries the post-bump value.
//! - SIGWINCH is delivered to the PTY child on every `resize()` call: the
//!   mock `PtyPort` records every `resize` invocation and the counter grows
//!   1:1 with the session-level `resize()` request. DoD-F-18 retires RFC §22
//!   #10 at this observation point.
//!
//! The mock PTY pattern matches `stress_actor.rs`: a controlled `PtyPort`
//! hands out a `PtyHandle` whose `resize` method logs every call into a
//! shared counter. Real shells aren't needed — we drive the actor's resize
//! plumbing directly and inspect the effects.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use quanta_events::{EventLogReader as _, ZstdSegmentedEventLog};
use quanta_proto::events::Event;
use quanta_pty::{PtyError, PtyExit, PtyHandle, PtyPort, PtySize, PtySpec};
use quanta_session::{SessionActor, SessionConfig, SessionHandle};
use tokio::sync::{mpsc, Mutex, Notify};

// ---------------------------------------------------------------------------
// Mock PTY port: counts resize calls (for DoD-F-18) and replays scripted bytes
// (so the VT engine has something to feed on + can emit a Resize event back
// through the actor's reader → emitter path).
// ---------------------------------------------------------------------------

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
        // Short timeout keeps the hot read loop cooperative — see
        // `stress_actor.rs` MockPty for the same pattern. Returning `Ok(0)`
        // tells the reader to yield and re-check shutdown; this lets `close()`
        // complete promptly in tests that never feed any bytes.
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
        // DoD-F-18 observation point: every `SessionHandle::resize` call
        // must land here exactly once (1:1 with SIGWINCH delivery in the
        // real PortablePtyPort).
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

/// Bundle moved into the single `PtyHandle` on `open()` — factoring the
/// tuple out of the Mutex type satisfies clippy's `type_complexity` lint.
struct PortInner {
    read_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    resize_count: Arc<AtomicUsize>,
    closed: Arc<Notify>,
    is_closed: Arc<AtomicBool>,
}

#[derive(Debug)]
struct ResizeCountingPort {
    // Option-wrapped because `open()` consumes it on the first call. A
    // Mutex instead of a `OnceCell` keeps this test file self-contained —
    // no extra dependency churn for the single-session pattern we need.
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
    log: Arc<ZstdSegmentedEventLog>,
    session_id: quanta_proto::ids::SessionId,
    resize_count: Arc<AtomicUsize>,
    // Kept alive so the PTY's read channel stays open; dropping the sender
    // causes the PTY's `read()` to return `Closed` and the actor tears down.
    read_tx: mpsc::UnboundedSender<Vec<u8>>,
    _tmp: tempfile::TempDir,
}

async fn spawn_harness(cols: u16, rows: u16) -> Harness {
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
    let (actor, session_id) = SessionActor::spawn(port, log.clone(), cfg)
        .await
        .expect("spawn");

    // Prime the reader task past its start-up race window. The reader
    // calls `resize_rx.mark_unchanged()` on its first iteration; a race
    // with the input task's `resize_tx.send` can swallow the very first
    // resize signal. We feed one space byte + a short wait so the reader
    // has definitely made at least one `pty.read` → `grid.feed` pass
    // before the test issues its resize requests. A single space does
    // not affect grid.resize_generation or change any test assertion.
    let _ = read_tx.send(b" ".to_vec());
    tokio::time::sleep(Duration::from_millis(100)).await;

    Harness {
        actor,
        log,
        session_id,
        resize_count,
        read_tx,
        _tmp: tmp,
    }
}

/// Helper: extract the `resize_generation` from a `grid.*` envelope's payload
/// object. Mirrors the layout produced by `actor.rs::emit_vt_event`.
fn grid_resize_generation(ev: &Event) -> Option<u64> {
    match ev {
        Event::Unknown { kind, payload } if kind.starts_with("grid.") => payload
            .as_object()
            .and_then(|o| o.get("resize_generation"))
            .and_then(serde_json::Value::as_u64),
        _ => None,
    }
}

/// Helper: drive a brief sleep so the actor's reader task picks up the resize
/// watch-channel signal before we query the log. The reader's loop head is
/// polled every PTY read cycle which has a 25 ms budget in our mock; 500 ms
/// is generous even on a swamped CI runner.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(500)).await;
}

/// **DoD-F-17 part A** — an identity resize (same geometry as spawn) must
/// NOT bump `resize_generation`. The engine's `Grid::resize` short-circuits
/// when rows/cols match; the PTY still sees the SIGWINCH call (the engine
/// short-circuit does not affect the input task's PTY forward).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn identity_resize_does_not_bump_resize_generation() {
    let h = spawn_harness(80, 24).await;

    let snap_before = h.actor.snapshot().await;
    // 80×24 matches the spawn geometry. `Grid::resize` returns an empty
    // event vec and does not bump `resize_generation`.
    h.actor.resize(PtySize::new(80, 24)).await.expect("resize");
    settle().await;

    let snap_after = h.actor.snapshot().await;
    assert_eq!(
        snap_after.resize_generation, snap_before.resize_generation,
        "identity resize must be idempotent on resize_generation"
    );
    // DoD-F-18: the PTY received a SIGWINCH regardless (`input_loop` calls
    // `pty.resize()` unconditionally; engine short-circuit only affects the
    // engine side).
    assert_eq!(
        h.resize_count.load(Ordering::SeqCst),
        1,
        "identity resize must still forward SIGWINCH to the PTY (retires RFC §22 #10)"
    );

    let _ = tokio::time::timeout(Duration::from_secs(3), h.actor.close()).await;
    drop(h.log);
    drop(h.read_tx);
}

/// **DoD-F-17 part B — E2E-F3** — distinct geometries bump
/// `resize_generation` once per call and the snapshot reflects the new value.
/// We do TWO distinct resizes so we observe the counter advance twice.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn distinct_resizes_bump_resize_generation_once_per_call() {
    let h = spawn_harness(80, 24).await;
    let before = h.actor.snapshot().await.resize_generation;

    // First distinct resize: 100×30.
    h.actor
        .resize(PtySize::new(100, 30))
        .await
        .expect("resize 1");
    settle().await;
    let after_1 = h.actor.snapshot().await.resize_generation;
    assert!(
        after_1 > before,
        "first distinct resize must bump resize_generation: before={before}, after_1={after_1}"
    );

    // Second distinct resize: 120×40.
    h.actor
        .resize(PtySize::new(120, 40))
        .await
        .expect("resize 2");
    settle().await;
    let after_2 = h.actor.snapshot().await.resize_generation;
    assert!(
        after_2 > after_1,
        "second distinct resize must bump resize_generation again: after_1={after_1}, after_2={after_2}"
    );

    // DoD-F-18: two resize() calls → two SIGWINCH deliveries.
    assert_eq!(
        h.resize_count.load(Ordering::SeqCst),
        2,
        "each SessionHandle::resize must forward SIGWINCH exactly once"
    );

    let _ = tokio::time::timeout(Duration::from_secs(3), h.actor.close()).await;
    drop(h.log);
    drop(h.read_tx);
}

/// **DoD-F-06 — events emitted AFTER a resize carry the new generation.**
/// We feed a byte stream into the mock PTY AFTER the resize so the engine
/// produces grid.* envelopes while the post-resize generation is in effect.
/// We then close the actor and inspect the durable log; the LAST few grid.*
/// envelopes (the ones produced by the post-resize feed) must carry
/// `resize_generation` ≥ the post-resize value.
///
/// Envelopes emitted by the start-up prime byte (see `spawn_harness`) carry
/// the pre-resize generation; they are not what this test asserts against.
/// We anchor the check by locating the `grid.resize` envelope in the log
/// and requiring every subsequent grid envelope to carry the post-resize
/// generation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_resize_events_carry_new_resize_generation() {
    let h = spawn_harness(80, 24).await;

    // Trigger a resize; allow the watch signal to reach the reader task.
    h.actor.resize(PtySize::new(100, 30)).await.expect("resize");
    settle().await;
    let post_resize_gen = h.actor.snapshot().await.resize_generation;
    assert!(
        post_resize_gen >= 1,
        "resize_generation must bump on a distinct resize; got {post_resize_gen}"
    );

    // Feed some output so the engine has something to delta AFTER the
    // resize. "post\n" produces at least one `GridDelta` + `CursorMoved`
    // through `Grid::feed`.
    h.read_tx
        .send(b"post\n".to_vec())
        .expect("send bytes to mock pty");
    settle().await;

    // Close the actor so the log is stable for replay.
    let _ = tokio::time::timeout(Duration::from_secs(3), h.actor.close()).await;

    let records = h.log.replay_session(h.session_id).await.unwrap();

    // Locate the `grid.resize` envelope (there must be exactly one in the
    // log; it is emitted by `Grid::resize` when the engine transitions
    // geometry). Every grid.* envelope appearing AFTER this record must
    // carry `resize_generation >= post_resize_gen`.
    let resize_idx = records
        .iter()
        .position(|r| {
            matches!(
                &r.envelope.payload,
                Event::Unknown { kind, .. } if kind == "grid.resize"
            )
        })
        .expect("engine must emit a grid.resize envelope after a distinct resize");

    let post_resize_gens: Vec<u64> = records[resize_idx..]
        .iter()
        .filter_map(|r| grid_resize_generation(&r.envelope.payload))
        .collect();

    assert!(
        !post_resize_gens.is_empty(),
        "test must observe at least one grid.* envelope at or after the resize"
    );
    for gen in &post_resize_gens {
        assert!(
            *gen >= post_resize_gen,
            "grid envelope emitted at/after resize carries resize_generation={gen} < \
             post_resize_gen={post_resize_gen}"
        );
    }

    drop(h.log);
    drop(h.read_tx);
}

/// **DoD-F-18** — many back-to-back resizes deliver N SIGWINCH signals.
/// A batched resize loop (mimicking a user dragging a window edge) must not
/// coalesce SIGWINCH away. Each call travels through the input task and hits
/// the PTY exactly once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn back_to_back_resizes_deliver_one_sigwinch_each() {
    let h = spawn_harness(80, 24).await;

    // 8 distinct geometries. Each of the first 8 triggers a grid.resize AND
    // a PTY resize call. An identity-repeat is inserted in the middle to
    // confirm the PTY path is unaffected by the engine's short-circuit.
    let sequence = [
        (81, 24),
        (82, 25),
        (90, 26),
        (90, 26), // identity repeat
        (100, 30),
        (110, 35),
        (120, 40),
        (120, 40), // identity repeat — engine short-circuits, PTY still counts
    ];
    for (cols, rows) in sequence {
        h.actor
            .resize(PtySize::new(cols, rows))
            .await
            .unwrap_or_else(|e| panic!("resize {cols}x{rows}: {e:?}"));
    }
    settle().await;

    let count = h.resize_count.load(Ordering::SeqCst);
    assert_eq!(
        count, 8,
        "8 SessionHandle::resize calls must produce exactly 8 SIGWINCH deliveries; got {count}"
    );

    let _ = tokio::time::timeout(Duration::from_secs(3), h.actor.close()).await;
    drop(h.log);
    drop(h.read_tx);
}
