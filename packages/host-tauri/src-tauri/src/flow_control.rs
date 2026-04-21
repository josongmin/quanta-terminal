//! Per-session PTY flow control (Plan 0005 Epic γ, P0 Gate #11).
//!
//! # What this module solves
//!
//! The TS frame-skip batcher (`packages/ui/src/shared/lib/write-batcher-frame-skip.ts`)
//! coalesces PTY bytes through `requestAnimationFrame`-scoped flushes. When the
//! queued-bytes gauge crosses `softCapBytes`, the batcher calls
//! `flowControl.pause()` on its injected hook — the intent is "stop the
//! producer NOW so we don't OOM". Symmetrically, `flowControl.resume()` fires
//! when the queue drains to 75 % of the cap.
//!
//! This module is the Rust end of that hook. Each PTY session owns an
//! [`FlowControl`] (held inside `SessionHandle`); the PTY reader thread calls
//! [`FlowControl::wait_if_paused`] before every read. When `pause()` is
//! invoked, the next call to `wait_if_paused` parks the reader on a
//! [`tokio::sync::Notify`] until `resume()` fires.
//!
//! # Why park the reader (Option A) rather than SIGSTOP the child (Option B)
//!
//!   * **Cross-platform.** ConPTY on Windows has no POSIX signals, so
//!     `kill(pid, SIGSTOP)` is Unix-only. Parking the reader thread works
//!     identically on Linux / macOS / Windows — the OS's PTY buffer fills,
//!     which transparently back-pressures the child (its write-side `write(2)`
//!     blocks once the kernel-side PTY buffer is full).
//!
//!   * **No signal semantics to reason about.** SIGSTOP is observable from the
//!     child's process table and upsets process-group operations (job
//!     control, `wait(2)` races). A paused reader is invisible.
//!
//!   * **Reliable wake.** `Notify` has unambiguous consumer-grade semantics —
//!     one notify-one wakes exactly one waiter; repeated pauses / resumes are
//!     idempotent because we drive an `AtomicBool` as the authoritative state
//!     and treat `Notify` purely as a wake channel.
//!
//! # Cross-platform caveats
//!
//!   * On Linux / macOS the kernel PTY buffer is 4–64 KiB. When full, the
//!     shell's next `write` blocks, propagating backpressure the whole way to
//!     the producing program. Flow control "just works" end-to-end.
//!   * On Windows ConPTY the reader-pause mechanism compiles and runs, but
//!     the ConPTY subsystem has its own buffering semantics we have not
//!     exhaustively characterized. We document this as **known-partial for
//!     Windows**; the follow-up ticket tracks moving to a ConPTY-native
//!     backpressure (or re-evaluating SIGSTOP equivalent via `NtSuspendProcess`).
//!   * This module does NOT implement SIGSTOP/SIGCONT. A future follow-up
//!     (epic-γ-rust-sigstop) can layer it on top if we find the PTY-level
//!     backpressure insufficient on any platform.
//!
//! # Idempotency
//!
//! Calling `pause()` on an already-paused control is a no-op. Calling
//! `resume()` on an already-running control is a no-op. The TS batcher fires
//! each transition exactly once per soft-cap crossing, but real clients (and
//! tests) exercise double-fire — we guarantee it stays cheap and safe.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

/// Per-session pause/resume gate for the PTY reader thread.
///
/// Cheap to clone (`Arc` internally). The reader thread holds one clone to
/// call `wait_if_paused`; the IPC command handlers hold another to flip
/// `pause()` / `resume()`.
#[derive(Debug, Clone)]
pub struct FlowControl {
    inner: Arc<FlowControlInner>,
}

#[derive(Debug)]
struct FlowControlInner {
    /// Authoritative "are we paused?" state. Drives the fast path of
    /// `wait_if_paused` — when false, we return instantly with zero syscalls.
    paused: AtomicBool,
    /// Async wake channel. `notify_waiters` is called from `resume()` to
    /// unblock every waiter currently parked in `wait_if_paused`.
    notify: Notify,
    /// Sync wake channel for the blocking reader thread path. The embedded
    /// shell's reader is a plain `std::thread::spawn` doing a blocking `read`
    /// on a `portable-pty` handle — it has no tokio runtime handy, so we
    /// expose [`FlowControl::block_if_paused`] that parks on a Condvar.
    /// Lives alongside (not instead of) `notify` so async consumers (the
    /// sidecar path, if it ever grows flow control) stay idiomatic.
    sync_mutex: Mutex<()>,
    sync_cv: Condvar,
}

impl FlowControl {
    /// Construct a new, un-paused flow-control gate.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(FlowControlInner {
                paused: AtomicBool::new(false),
                notify: Notify::new(),
                sync_mutex: Mutex::new(()),
                sync_cv: Condvar::new(),
            }),
        }
    }

    /// Signal pause. The next `wait_if_paused` / `block_if_paused` call will park.
    ///
    /// Idempotent: calling `pause()` while already paused is a no-op.
    pub fn pause(&self) {
        // Release ordering: the store must be visible to the reader thread
        // before its next wait call's load with Acquire.
        self.inner.paused.store(true, Ordering::Release);
    }

    /// Signal resume. Wakes every parked waiter (async or blocking).
    ///
    /// Idempotent: calling `resume()` while not paused is a no-op (the wake
    /// calls are cheap and have no effect when there are no waiters).
    pub fn resume(&self) {
        // Flip the flag BEFORE waking; a woken waiter will reload `paused`
        // under Acquire and see `false`. Without this ordering a waiter could
        // re-enter the park loop immediately.
        self.inner.paused.store(false, Ordering::Release);
        self.inner.notify.notify_waiters();
        // Wake every blocking waiter parked on the Condvar. We take the
        // mutex first so the Condvar broadcast interleaves correctly with
        // any waiter currently between its predicate check and its wait.
        {
            // The guard itself is immediately dropped; acquiring it serialises
            // against the `wait_while` loop inside `block_if_paused` so a
            // racing pause → resume cannot slip between the `paused` reload
            // and the `wait` deep inside the condvar impl.
            let _guard = self.inner.sync_mutex.lock().unwrap_or_else(|p| p.into_inner());
        }
        self.inner.sync_cv.notify_all();
    }

    /// Is the gate currently paused?
    #[allow(
        dead_code,
        reason = "surfaced for future telemetry + tests; the embedded-shell path uses block_if_paused directly"
    )]
    pub fn is_paused(&self) -> bool {
        self.inner.paused.load(Ordering::Acquire)
    }

    /// Blocking-thread counterpart to [`wait_if_paused`]. Parks the current
    /// thread until `resume()` fires or `timeout` elapses; returns the same
    /// fast-path (no parking) when already unpaused.
    ///
    /// The embedded-shell reader loop uses this: it runs on
    /// `std::thread::spawn` with no tokio runtime, and the `portable-pty`
    /// `read` is itself blocking, so mixing async here would pull in a
    /// tokio runtime just to bridge. The Condvar path is zero-dep.
    ///
    /// Returns `true` if we observed an unpaused state (either the fast path
    /// or after a wake); `false` if `timeout` elapsed while still paused. The
    /// caller typically ignores the return value and loops back into the
    /// read attempt — the timeout exists so the reader can still react to
    /// EOF / kill on a dead PTY without holding the condvar forever.
    pub fn block_if_paused(&self, timeout: Duration) -> bool {
        if !self.inner.paused.load(Ordering::Acquire) {
            return true;
        }
        // Acquire the mutex, then wait while paused. Condvar::wait_timeout_while
        // re-checks the predicate under the mutex on wake, which closes the
        // standard lost-wakeup race with `pause()` flipping the flag again
        // between our initial load and the wait.
        let guard = match self.inner.sync_mutex.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let paused = &self.inner.paused;
        let (_guard, wait_res) = self
            .inner
            .sync_cv
            .wait_timeout_while(guard, timeout, |_| paused.load(Ordering::Acquire))
            .unwrap_or_else(|p| {
                let (g, r) = p.into_inner();
                (g, r)
            });
        !wait_res.timed_out()
    }

    /// Park until `resume()` fires. Returns immediately when not paused.
    ///
    /// The async counterpart to [`block_if_paused`]. The reader loop SHOULD
    /// call this before every `read()` on the PTY when running on a tokio
    /// task; when not paused, the cost is one atomic load and a function
    /// return — cheap enough to sit on the hot byte-pump path.
    ///
    /// # Cancellation
    ///
    /// This future is cancel-safe: dropping it mid-wait does not leave the
    /// `FlowControl` in an inconsistent state. The next caller will simply
    /// observe the current `paused` flag and park again if needed.
    #[allow(
        dead_code,
        reason = "async variant reserved for the sidecar path (ADR 0004); embedded-shell uses block_if_paused"
    )]
    pub async fn wait_if_paused(&self) {
        // Fast path: no fence, no await. The overwhelming majority of calls
        // see `paused == false` and bail out immediately.
        if !self.inner.paused.load(Ordering::Acquire) {
            return;
        }

        // Slow path. We loop so a spurious wake (e.g. `notify_waiters` fires
        // while `paused` is still true because another caller raced in a new
        // pause) doesn't let us slip through with `paused == true`.
        loop {
            // Create the wait future BEFORE re-checking `paused` so we don't
            // miss a `notify_waiters` that races between our load and the
            // `await`. `Notify::notified` documents this "register before
            // check" ordering contract.
            let wait = self.inner.notify.notified();
            if !self.inner.paused.load(Ordering::Acquire) {
                return;
            }
            wait.await;
            // After wake, loop once more to confirm `paused` is cleared.
            // `resume()` sets `paused = false` BEFORE calling notify, so the
            // reload should see `false`, but we re-check to defend against a
            // racing pause → resume → pause sequence.
            if !self.inner.paused.load(Ordering::Acquire) {
                return;
            }
        }
    }
}

impl Default for FlowControl {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::time::Duration;

    #[test]
    fn new_flow_control_starts_unpaused() {
        let fc = FlowControl::new();
        assert!(!fc.is_paused(), "new FlowControl must not be paused");
    }

    #[test]
    fn pause_marks_paused() {
        let fc = FlowControl::new();
        fc.pause();
        assert!(fc.is_paused(), "pause() must flip the gauge");
    }

    #[test]
    fn resume_clears_paused() {
        let fc = FlowControl::new();
        fc.pause();
        fc.resume();
        assert!(!fc.is_paused(), "resume() must clear the gauge");
    }

    #[test]
    fn double_pause_is_idempotent() {
        let fc = FlowControl::new();
        fc.pause();
        fc.pause();
        assert!(fc.is_paused());
        fc.resume();
        assert!(!fc.is_paused());
    }

    #[test]
    fn double_resume_is_idempotent() {
        let fc = FlowControl::new();
        fc.resume();
        fc.resume();
        assert!(!fc.is_paused());
        fc.pause();
        assert!(fc.is_paused());
    }

    #[tokio::test]
    async fn wait_if_paused_returns_immediately_when_not_paused() {
        let fc = FlowControl::new();
        // If this ever deadlocks, the test times out — tokio's default
        // test runtime catches that. An unpaused wait must be a no-op.
        let start = std::time::Instant::now();
        fc.wait_if_paused().await;
        assert!(
            start.elapsed() < Duration::from_millis(50),
            "wait_if_paused() on unpaused control must return promptly"
        );
    }

    #[tokio::test]
    async fn resume_unblocks_waiter() {
        let fc = FlowControl::new();
        fc.pause();

        let waiter_fc = fc.clone();
        let counter = Arc::new(AtomicUsize::new(0));
        let counter_w = counter.clone();
        let handle = tokio::spawn(async move {
            waiter_fc.wait_if_paused().await;
            counter_w.fetch_add(1, AtomicOrdering::SeqCst);
        });

        // Give the waiter a chance to park; 20 ms is ample on every CI
        // runner we ship on.
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            counter.load(AtomicOrdering::SeqCst),
            0,
            "waiter must still be parked before resume"
        );

        fc.resume();
        handle.await.expect("waiter task joined cleanly");
        assert_eq!(
            counter.load(AtomicOrdering::SeqCst),
            1,
            "waiter must observe resume and complete"
        );
    }

    #[tokio::test]
    async fn multiple_waiters_all_wake_on_resume() {
        let fc = FlowControl::new();
        fc.pause();

        let counter = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let fc = fc.clone();
            let c = counter.clone();
            handles.push(tokio::spawn(async move {
                fc.wait_if_paused().await;
                c.fetch_add(1, AtomicOrdering::SeqCst);
            }));
        }

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(counter.load(AtomicOrdering::SeqCst), 0);

        fc.resume();
        for h in handles {
            h.await.expect("waiter joined cleanly");
        }
        assert_eq!(
            counter.load(AtomicOrdering::SeqCst),
            4,
            "every parked waiter must wake on resume"
        );
    }

    #[tokio::test]
    async fn pause_then_resume_then_pause_reparks_fresh_waiters() {
        let fc = FlowControl::new();

        // Cycle 1: pause/resume with a live waiter.
        fc.pause();
        let fc_a = fc.clone();
        let h = tokio::spawn(async move {
            fc_a.wait_if_paused().await;
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        fc.resume();
        h.await.unwrap();

        // Cycle 2: a subsequent pause must park a new waiter.
        fc.pause();
        let fc_b = fc.clone();
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();
        let h2 = tokio::spawn(async move {
            fc_b.wait_if_paused().await;
            c.fetch_add(1, AtomicOrdering::SeqCst);
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(counter.load(AtomicOrdering::SeqCst), 0);
        fc.resume();
        h2.await.unwrap();
        assert_eq!(counter.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn clones_share_state() {
        let fc = FlowControl::new();
        let clone = fc.clone();
        fc.pause();
        assert!(clone.is_paused(), "clone must observe pause on the original");
        clone.resume();
        assert!(
            !fc.is_paused(),
            "original must observe resume on the clone (shared state)"
        );
    }

    #[test]
    fn block_if_paused_returns_true_when_unpaused() {
        let fc = FlowControl::new();
        let start = std::time::Instant::now();
        assert!(fc.block_if_paused(Duration::from_secs(5)));
        assert!(
            start.elapsed() < Duration::from_millis(50),
            "unpaused block_if_paused must return promptly"
        );
    }

    #[test]
    fn block_if_paused_unblocks_on_resume() {
        let fc = FlowControl::new();
        fc.pause();

        let waiter = fc.clone();
        let counter = Arc::new(AtomicUsize::new(0));
        let counter_w = counter.clone();
        let handle = std::thread::spawn(move || {
            let ok = waiter.block_if_paused(Duration::from_secs(5));
            assert!(ok, "resume must unblock before the timeout");
            counter_w.fetch_add(1, AtomicOrdering::SeqCst);
        });

        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(
            counter.load(AtomicOrdering::SeqCst),
            0,
            "thread must still be parked before resume"
        );

        fc.resume();
        handle.join().expect("waiter thread joined cleanly");
        assert_eq!(counter.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn block_if_paused_returns_false_on_timeout() {
        let fc = FlowControl::new();
        fc.pause();
        // Short timeout so the test runs fast; assert the return distinguishes
        // timeout from resume-wake so the reader loop can react to dead PTYs.
        let start = std::time::Instant::now();
        let ok = fc.block_if_paused(Duration::from_millis(50));
        assert!(!ok, "timeout expiry must return false");
        assert!(
            start.elapsed() >= Duration::from_millis(50),
            "the call must honour the timeout"
        );
    }
}
