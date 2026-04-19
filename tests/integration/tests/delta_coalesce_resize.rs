//! **Integration — GridDelta coalescing at resize_generation boundaries.**
//!
//! This suite exercises the contract implied by ADR 0011 (event identity,
//! monotonic sequence, at-least-once delivery) and RFC §7 (delta model) at
//! the `resize_generation` boundary. The question under test is:
//!
//!     "When several SIGWINCH-equivalent resize requests land in quick
//!     succession, does the pipeline emit an engine-level event per call, or
//!     does it coalesce at some layer?"
//!
//! The production plumbing has two independent coalescing surfaces:
//!
//! 1. **PTY path (input task → `PtyHandle::resize`).** Every call travels
//!    through the input mpsc and is forwarded 1:1 to the PTY. No coalescing
//!    here — retires RFC §22 #10 at `resize_generation.rs::back_to_back_
//!    resizes_deliver_one_sigwinch_each`. This file does NOT re-assert that.
//!
//! 2. **Engine path (input task → `watch::channel` → reader task →
//!    `Grid::resize`).** The reader consults the watch channel at the TOP of
//!    its read loop: if several `resize_tx.send(size)` happened since the
//!    last poll, only the LATEST value is observed. That is a watch channel's
//!    defining behaviour (see
//!    `crates/quanta-session/src/adapters/actor.rs` ~line 1250).
//!    The consequence is that the engine CAN coalesce intermediate resizes;
//!    whether it does depends entirely on timing. This suite pins the
//!    observable outcomes under both the "each resize gets its own engine
//!    cycle" and "N resizes collapsed to 1 engine cycle" regimes.
//!
//! ## Scenario matrix
//!
//! | #  | Test                                                                    | Scenario |
//! |----|-------------------------------------------------------------------------|----------|
//! | 1  | `rapid_resizes_converge_to_final_dimension`                              | 3 fast resizes — final dimension is authoritative on snapshot |
//! | 2  | `resize_data_resize_data_lands_on_new_generation`                        | resize → feed → resize → feed: second feed's events carry post-2nd-gen |
//! | 3  | `snapshot_after_resize_carries_new_generation`                           | snapshot taken after resize reflects the bumped generation |
//! | 4  | `resize_generation_is_strictly_monotone_across_many_resizes`             | 5 sequential distinct resizes produce strictly-increasing gens |
//! | 5  | `very_rapid_resizes_converge_to_final_state`                             | 10 resizes in tight loop — final snapshot matches last dimension |
//! | 6  | `monotonic_seq_across_resize_boundary_is_gap_free`                       | ADR 0011: no gaps, strictly ascending seq across resize transitions |
//! | 7  | `interleaved_resize_and_feed_stamps_envelopes_correctly`                 | envelope stamping: pre-resize envelopes carry old gen, post carry new |
//!
//! Tests own the scheduling; they call `settle()` after each resize so the
//! reader task has a chance to drain the watch channel. The engine-coalesce
//! regime is EXPECTED when a burst of resize_tx sends happens in a tight
//! loop faster than the reader can poll — we observe that directly in test 5.
//!
//! ## Why not a network-level integration?
//!
//! Earlier integration tests in this directory (`full_stack_e2e.rs`,
//! `resume_vt.rs`) drive a real `quanta-core` over a unix socket. That is the
//! right harness for reducer+replay behaviour but too coarse for observing
//! the coalesce boundary: by the time a burst of resize RPCs arrives over the
//! socket, the first one has often already flushed. Using the session actor
//! directly lets us pin the race window precisely.
//!
//! The mock PTY pattern is lifted from
//! `crates/quanta-session/tests/resize_generation.rs` with the rapid-burst
//! tests added here.

#![allow(
    clippy::cast_possible_truncation,
    reason = "test-only arithmetic on u16 dimensions"
)]

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
// Mock PTY — a minimal PtyPort that counts resize calls and accepts scripted
// byte input on an mpsc so tests can interleave feed + resize freely.
// Mirrors the pattern in `resize_generation.rs` and `stress_actor.rs`.
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct MockPty {
    read_rx: Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    resize_count: Arc<AtomicUsize>,
    closed: Arc<Notify>,
    is_closed: Arc<AtomicBool>,
}

#[async_trait]
impl PtyHandle for MockPty {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError> {
        if self.is_closed.load(Ordering::Acquire) {
            return Err(PtyError::Closed);
        }
        let mut guard = self.read_rx.lock().await;
        // Short poll → the reader task yields regularly so the watch-channel
        // race window for resize coalescing is observable rather than hidden
        // inside a 1-second blocking read.
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

struct PortSeed {
    read_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    resize_count: Arc<AtomicUsize>,
    closed: Arc<Notify>,
    is_closed: Arc<AtomicBool>,
}

impl std::fmt::Debug for PortSeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortSeed").finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct MockPort {
    seed: Mutex<Option<PortSeed>>,
}

#[async_trait]
impl PtyPort for MockPort {
    async fn open(&self, _spec: PtySpec) -> Result<Box<dyn PtyHandle>, PtyError> {
        let seed = self
            .seed
            .lock()
            .await
            .take()
            .ok_or_else(|| PtyError::Spawn("mock port already opened".into()))?;
        Ok(Box::new(MockPty {
            read_rx: Mutex::new(seed.read_rx),
            resize_count: seed.resize_count,
            closed: seed.closed,
            is_closed: seed.is_closed,
        }))
    }
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

struct Harness {
    actor: SessionActor,
    log: Arc<ZstdSegmentedEventLog>,
    session_id: quanta_proto::ids::SessionId,
    resize_count: Arc<AtomicUsize>,
    /// Kept alive so the mock PTY's `read()` doesn't EOF; dropping this tears
    /// down the actor's reader task.
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

    let port = Arc::new(MockPort {
        seed: Mutex::new(Some(PortSeed {
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
        .expect("spawn session actor");

    // Prime the reader past the start-up resize-watch race (see
    // `resize_generation.rs::spawn_harness`). One space byte + a small wait
    // ensures the reader has made at least one `pty.read` → `grid.feed`
    // loop pass before the test interacts with resizes.
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

/// Wait long enough for the reader task to drain any pending resize signal.
/// Reader loop head polls the watch channel every PTY-read cycle (25 ms
/// budget on our mock), so 500 ms is generous.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(500)).await;
}

/// Close the actor. Does NOT drop the harness — the harness owns the
/// `TempDir` whose `Drop` deletes the log's on-disk directory, so the
/// caller must keep the `Harness` alive until after any `replay_session`
/// read. (This was the footgun that turned our first replay runs empty.)
async fn close_actor(h: &Harness) {
    let _ = tokio::time::timeout(Duration::from_secs(3), h.actor.close()).await;
}

/// Extract `resize_generation` from an `Event::Unknown { kind: "grid.*" }`
/// payload — mirrors `actor.rs::emit_vt_event`'s shape.
fn grid_gen(ev: &Event) -> Option<u64> {
    match ev {
        Event::Unknown { kind, payload } if kind.starts_with("grid.") => payload
            .as_object()
            .and_then(|o| o.get("resize_generation"))
            .and_then(serde_json::Value::as_u64),
        _ => None,
    }
}

/// Extract the inner grid event-kind discriminator from the `grid.*` unknown
/// envelope. Returns `None` for non-grid events.
fn grid_kind(ev: &Event) -> Option<&str> {
    match ev {
        Event::Unknown { kind, .. } if kind.starts_with("grid.") => Some(kind.as_str()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Test 1 — rapid resizes converge to the final dimension.
// ---------------------------------------------------------------------------

/// **Scenario 1 — three rapid resizes; final dimension wins on snapshot.**
///
/// We issue three distinct resizes without `settle` between them. The watch
/// channel behaviour means the reader task may observe EITHER:
///
/// * all three, sequentially (slow reader → full sequence) — upper bound on
///   `resize_generation` bump is +3.
/// * only the final one (fast burst, reader task hasn't yet looped) — lower
///   bound on `resize_generation` bump is +1.
///
/// Either way the snapshot AFTER `settle` must carry a value that reflects
/// at least one bump, and the PTY layer must have seen exactly three SIGWINCH
/// calls (that path does NOT coalesce).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rapid_resizes_converge_to_final_dimension() {
    let h = spawn_harness(80, 24).await;
    let before = h.actor.snapshot().await.resize_generation;

    // Three resizes in a tight loop — no settle between them.
    h.actor.resize(PtySize::new(90, 26)).await.expect("r1");
    h.actor.resize(PtySize::new(100, 28)).await.expect("r2");
    h.actor.resize(PtySize::new(110, 30)).await.expect("r3");
    settle().await;

    let after = h.actor.snapshot().await.resize_generation;
    assert!(
        after > before,
        "at least one resize must bump the generation; before={before} after={after}"
    );
    // Upper bound — the watch channel cannot synthesize extra generations.
    assert!(
        after <= before + 3,
        "generation cannot bump MORE than the number of resize() calls; \
         before={before} after={after}"
    );

    // PTY path is unaffected by watch coalescing — 3 calls → 3 SIGWINCH.
    assert_eq!(
        h.resize_count.load(Ordering::SeqCst),
        3,
        "every SessionHandle::resize must deliver one SIGWINCH"
    );

    close_actor(&h).await;
}

// ---------------------------------------------------------------------------
// Test 2 — resize → feed → resize → feed: envelope stamping.
// ---------------------------------------------------------------------------

/// **Scenario 2 — resize(80x24) → feed "hello" → resize(100x30) → feed "!".**
///
/// The bytes fed BEFORE the second resize must carry the post-first-resize
/// generation (or the initial 1 if the reader collapsed both); the bytes fed
/// AFTER the second resize must carry a STRICTLY-GREATER generation than
/// whatever stamp the pre-second-resize bytes got.
///
/// This is a direct check of ADR 0011's "every envelope carries authoritative
/// metadata" contract at the resize boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_data_resize_data_lands_on_new_generation() {
    let h = spawn_harness(80, 24).await;

    // First resize (distinct from spawn so the engine bumps).
    h.actor.resize(PtySize::new(80, 24)).await.expect("r1");
    settle().await;
    // r1 is an identity resize (spawn geometry was 80x24) — does NOT bump.
    // Use a distinct value below instead. We nonetheless keep the identity
    // call above to confirm the test's own baseline behaviour.

    h.actor.resize(PtySize::new(90, 26)).await.expect("r1-real");
    settle().await;
    let gen_after_first = h.actor.snapshot().await.resize_generation;

    // Feed "hello\n" — produces at least one grid.grid_delta.
    h.read_tx.send(b"hello\n".to_vec()).expect("feed 1");
    settle().await;

    // Second resize.
    h.actor.resize(PtySize::new(100, 30)).await.expect("r2");
    settle().await;
    let gen_after_second = h.actor.snapshot().await.resize_generation;
    assert!(
        gen_after_second > gen_after_first,
        "second resize must bump the generation: {gen_after_first} → {gen_after_second}"
    );

    // Feed "!" — this chunk's envelopes must carry gen_after_second.
    h.read_tx.send(b"!\n".to_vec()).expect("feed 2");
    settle().await;

    // Close so the log is stable. IMPORTANT: do NOT drop `h` before
    // `replay_session` reads — the `TempDir` inside would delete the log
    // directory on drop and give us an empty replay.
    close_actor(&h).await;
    let records = h.log.replay_session(h.session_id).await.unwrap();

    // Locate the SECOND grid.resize envelope. Every grid.* envelope after
    // that index must carry `gen >= gen_after_second`.
    let resize_positions: Vec<usize> = records
        .iter()
        .enumerate()
        .filter_map(|(i, r)| match grid_kind(&r.envelope.payload) {
            Some("grid.resize") => Some(i),
            _ => None,
        })
        .collect();
    assert!(
        resize_positions.len() >= 2,
        "must see at least 2 grid.resize envelopes (first=80x24 identity was a no-op; \
         first-real=90x26, second=100x30); got {} = {:?}",
        resize_positions.len(),
        resize_positions
    );

    let second_resize_idx = *resize_positions
        .last()
        .expect("at least one grid.resize envelope");
    let post_gens: Vec<u64> = records[second_resize_idx..]
        .iter()
        .filter_map(|r| grid_gen(&r.envelope.payload))
        .collect();
    for g in &post_gens {
        assert!(
            *g >= gen_after_second,
            "envelope after 2nd grid.resize carries gen={g} < gen_after_second={gen_after_second}"
        );
    }
}

// ---------------------------------------------------------------------------
// Test 3 — snapshot after resize carries new generation.
// ---------------------------------------------------------------------------

/// **Scenario 3 — `SessionActor::snapshot()` reflects the post-resize
/// generation after the reader has processed the watch-channel signal.**
///
/// The session snapshot is the host-visible surface for "what's the engine's
/// current geometry/generation". If the reader hasn't yet processed the
/// resize, the snapshot may return the old value — which is ADR 0011
/// compliant (at-least-once + eventually-consistent host view) but we want
/// the EVENTUAL value to match after `settle`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_after_resize_carries_new_generation() {
    let h = spawn_harness(80, 24).await;
    let before = h.actor.snapshot().await.resize_generation;

    h.actor.resize(PtySize::new(120, 40)).await.expect("resize");
    settle().await;

    let after = h.actor.snapshot().await.resize_generation;
    assert_eq!(
        after,
        before + 1,
        "one distinct resize must bump resize_generation by exactly 1 \
         once the reader has drained the watch channel; before={before} after={after}"
    );

    close_actor(&h).await;
}

// ---------------------------------------------------------------------------
// Test 4 — strict monotonicity across sequential distinct resizes.
// ---------------------------------------------------------------------------

/// **Scenario 4 — five sequential distinct resizes with settle between each.**
///
/// When each resize is allowed to settle, no coalescing can happen. The
/// engine must bump `resize_generation` EXACTLY once per call — five calls
/// → +5. This is the "no coalescing under clean scheduling" baseline.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_generation_is_strictly_monotone_across_many_resizes() {
    let h = spawn_harness(80, 24).await;
    let start = h.actor.snapshot().await.resize_generation;

    let sequence = [(90, 26), (100, 28), (110, 30), (120, 32), (130, 34)];
    let mut observed = Vec::with_capacity(sequence.len());
    for (cols, rows) in sequence {
        h.actor
            .resize(PtySize::new(cols, rows))
            .await
            .unwrap_or_else(|e| panic!("resize {cols}x{rows} failed: {e:?}"));
        settle().await;
        observed.push(h.actor.snapshot().await.resize_generation);
    }

    // Strict monotonicity.
    for pair in observed.windows(2) {
        assert!(
            pair[1] > pair[0],
            "resize_generation must strictly increase between settled resizes; \
             observed={observed:?}"
        );
    }

    // Under settled scheduling, the jump is exactly 1 per call.
    assert_eq!(
        *observed.last().unwrap(),
        start + sequence.len() as u64,
        "5 settled resizes must bump by exactly 5; observed={observed:?} start={start}"
    );

    close_actor(&h).await;
}

// ---------------------------------------------------------------------------
// Test 5 — very-rapid burst; final state converges regardless of coalescing.
// ---------------------------------------------------------------------------

/// **Scenario 5 — 10 resizes issued in a tight loop, no settle between them.**
///
/// The watch channel may collapse any subset of these into a single reader-
/// side resize. What must hold is:
///
/// * Final `resize_generation` ≥ `start + 1` (at least one bump).
/// * Final `resize_generation` ≤ `start + 10` (no phantom bumps).
/// * PTY received exactly 10 SIGWINCH (no coalescing on that path).
///
/// This is the explicit observation that the engine path CAN coalesce under
/// burst load. No test in `resize_generation.rs` asserts this because that
/// file only cares about the settled case.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn very_rapid_resizes_converge_to_final_state() {
    let h = spawn_harness(80, 24).await;
    let before = h.actor.snapshot().await.resize_generation;

    // Ten distinct geometries, zero sleep between.
    for i in 0..10u16 {
        let cols = 81 + i;
        let rows = 25 + i;
        h.actor.resize(PtySize::new(cols, rows)).await.unwrap();
    }
    settle().await;

    let after = h.actor.snapshot().await.resize_generation;
    assert!(
        after > before,
        "at least one resize must bump: before={before} after={after}"
    );
    assert!(
        after <= before + 10,
        "bump count cannot exceed the number of distinct resize() calls; \
         before={before} after={after}"
    );
    assert_eq!(
        h.resize_count.load(Ordering::SeqCst),
        10,
        "PTY layer is coalesce-free; 10 calls → 10 SIGWINCH"
    );

    close_actor(&h).await;
}

// ---------------------------------------------------------------------------
// Test 6 — ADR 0011 §monotonic_seq contract across the resize boundary.
// ---------------------------------------------------------------------------

/// **Scenario 6 — `monotonic_seq` is gap-free and strictly ascending across
/// resize transitions.**
///
/// ADR 0011: "per-session sequence. Gaps are never allowed; a gap is a
/// corruption signal." The resize path emits envelopes on both the input
/// task (`SessionCreated`/etc) and the reader task (`grid.resize`,
/// `grid.grid_snapshot`, subsequent deltas). Both funnel through the single
/// emitter task, which is the single seq assigner. A race in the assignment
/// code would manifest as either a gap or a repeat here.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn monotonic_seq_across_resize_boundary_is_gap_free() {
    let h = spawn_harness(80, 24).await;

    // Interleave resizes and feeds so the emitter sees both input-task and
    // reader-task envelopes concurrently.
    h.actor.resize(PtySize::new(90, 26)).await.unwrap();
    h.read_tx.send(b"alpha\n".to_vec()).unwrap();
    h.actor.resize(PtySize::new(100, 28)).await.unwrap();
    h.read_tx.send(b"beta\n".to_vec()).unwrap();
    h.actor.resize(PtySize::new(110, 30)).await.unwrap();
    h.read_tx.send(b"gamma\n".to_vec()).unwrap();
    settle().await;

    close_actor(&h).await;
    let records = h.log.replay_session(h.session_id).await.unwrap();
    assert!(
        !records.is_empty(),
        "replay must return at least the SessionCreated + resize envelopes"
    );

    // Strict ascending + gap-free (contiguous by 1). ADR 0011 §Event
    // Identity: "Gaps are never allowed; a gap is a corruption signal."
    for pair in records.windows(2) {
        let a = pair[0].envelope.monotonic_seq;
        let b = pair[1].envelope.monotonic_seq;
        assert!(
            b > a,
            "monotonic_seq must be strictly ascending; saw {a} → {b}"
        );
        assert_eq!(
            b,
            a + 1,
            "monotonic_seq must be gap-free per ADR 0011; saw {a} → {b}"
        );
    }
}

// ---------------------------------------------------------------------------
// Test 7 — envelope stamping correctness across the resize boundary.
// ---------------------------------------------------------------------------

/// **Scenario 7 — every grid.* envelope carries a `resize_generation` no
/// greater than the engine's value AT the moment the envelope was emitted.**
///
/// The stronger invariant we check: grid.* envelopes appearing in the log
/// are partitioned into two regions by the grid.resize records — everything
/// BEFORE the first grid.resize carries gen==1 (the engine's initial value);
/// everything AFTER the last grid.resize carries gen==max_gen. No envelope
/// straddles the boundary (i.e., we never see a gen-N delta AFTER a
/// gen-(N+1) grid.resize record — that would be a stamping race).
///
/// Retires the "post-resize envelopes carry new generation" part of the
/// envelope contract at the E2E observation point.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interleaved_resize_and_feed_stamps_envelopes_correctly() {
    let h = spawn_harness(80, 24).await;

    // Feed BEFORE any resize.
    h.read_tx.send(b"pre1\n".to_vec()).unwrap();
    settle().await;

    // Resize.
    h.actor.resize(PtySize::new(100, 30)).await.unwrap();
    settle().await;

    // Feed AFTER resize.
    h.read_tx.send(b"post1\n".to_vec()).unwrap();
    settle().await;

    // Second resize.
    h.actor.resize(PtySize::new(120, 40)).await.unwrap();
    settle().await;

    // Feed after second.
    h.read_tx.send(b"post2\n".to_vec()).unwrap();
    settle().await;

    let final_gen = h.actor.snapshot().await.resize_generation;
    close_actor(&h).await;
    let records = h.log.replay_session(h.session_id).await.unwrap();

    // Collect (idx, gen) pairs for grid envelopes and the positions of the
    // grid.resize markers.
    let mut grid_pairs: Vec<(usize, u64)> = Vec::new();
    let mut resize_positions: Vec<usize> = Vec::new();
    for (i, r) in records.iter().enumerate() {
        if let Some(g) = grid_gen(&r.envelope.payload) {
            grid_pairs.push((i, g));
        }
        if matches!(grid_kind(&r.envelope.payload), Some("grid.resize")) {
            resize_positions.push(i);
        }
    }

    // We expect two grid.resize markers (one per distinct resize call).
    assert_eq!(
        resize_positions.len(),
        2,
        "two distinct resizes must produce two grid.resize envelopes; got {} = {:?}",
        resize_positions.len(),
        resize_positions
    );

    // The generation stamp must be MONOTONICALLY NON-DECREASING along the
    // record timeline. If the stamping path had a race (e.g. reader loaded
    // `resize_generation` before `Grid::feed` but AFTER `Grid::resize`), we
    // could see a gen-N delta appear after a gen-(N+1) envelope. Rule that
    // out.
    for pair in grid_pairs.windows(2) {
        let (_, ga) = pair[0];
        let (_, gb) = pair[1];
        assert!(
            gb >= ga,
            "grid.* envelope stamps must be non-decreasing; saw {ga} → {gb} \
             (pairs={grid_pairs:?})"
        );
    }

    // The final grid envelope's gen must equal the snapshot's final gen —
    // that is, the last feed DID see the bumped value.
    let last_gen = grid_pairs.last().map(|(_, g)| *g);
    assert_eq!(
        last_gen,
        Some(final_gen),
        "the last grid.* envelope's generation must equal the final \
         snapshot's resize_generation; last_gen={last_gen:?} final={final_gen}"
    );
}
