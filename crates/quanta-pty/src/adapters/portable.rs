//! `portable-pty`-backed implementation of `PtyPort`.
//!
//! `portable-pty` offers only a blocking `Read`. To avoid starving writes
//! behind an indefinite `read()` call (which would happen if the session actor
//! held an outer mutex across a blocking read), this adapter launches a
//! dedicated OS thread at `open()` that continuously pumps bytes from the PTY
//! reader into an unbounded `std::sync::mpsc` channel. The async `read()`
//! implementation pulls from that channel via `spawn_blocking`-less recv, so
//! it yields promptly and never holds locks across indefinite waits.
//!
//! This lets reads and writes proceed concurrently at the adapter level
//! without requiring changes to the `PtyHandle` port surface.
//!
//! # Panic policy
//!
//! The adapter's `std::sync::Mutex` `lock().expect(...)` calls exist in the
//! blocking closures passed to `spawn_blocking`. The only way they can fail
//! is mutex poisoning, which happens when a prior lock holder panicked while
//! the lock was held. Because none of our blocking closures panic
//! intentionally, a poisoned mutex means the PTY state is already in an
//! unknown partial state — propagating the panic is the correct outcome
//! under ADR 0004 (release profile aborts, supervisor restarts).

use std::io::{Read, Write};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use async_trait::async_trait;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize as PPtySize};

use crate::domain::{PtyExit, PtySize, PtySpec};
use crate::ports::{PtyError, PtyHandle, PtyPort};

// Unix-only termios helpers used to disable the PTY line-discipline ECHO
// flags before the child process inherits it. See `disable_echo_on_master`
// for the full rationale.
#[cfg(unix)]
use std::os::fd::{BorrowedFd, RawFd};
#[cfg(unix)]
use nix::sys::termios::{tcgetattr, tcsetattr, LocalFlags, SetArg};

/// Bounded capacity for the reader thread's channel. Backpressure on the
/// reader thread naturally throttles the PTY; 256 chunks × 8 KiB = 2 MiB
/// of in-flight output before the thread parks.
const READER_CHANNEL_CAPACITY: usize = 256;

/// Default adapter that uses the native PTY on the host OS.
#[derive(Debug, Default, Clone, Copy)]
pub struct PortablePtyPort;

impl PortablePtyPort {
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl PtyPort for PortablePtyPort {
    async fn open(&self, spec: PtySpec) -> Result<Box<dyn PtyHandle>, PtyError> {
        let handle = tokio::task::spawn_blocking(move || open_blocking(&spec))
            .await
            .map_err(|e| PtyError::Spawn(format!("join error: {e}")))??;
        Ok(Box::new(handle))
    }
}

/// Message from the reader thread to the async side.
enum ReadMsg {
    Bytes(Vec<u8>),
    Eof,
    Err(String),
}

/// Clear the ECHO family of `LocalFlags` on the **slave** pty's line
/// discipline so the child shell never echoes bytes we write.
///
/// # Why master doesn't work (was the bug)
///
/// On macOS and Linux the pseudo-terminal pair has **separate** termios
/// on the master and slave sides. Quoting `pty(4)` on macOS: "Ioctls
/// affecting the underlying device driver such as `TIOC_{GET,SET}ATTR`
/// are only honored on the slave side." Setting `ECHO` off on the
/// master fd returns `Ok(())` but is a no-op on the line discipline,
/// so the child (which only sees the slave) still runs with `ECHO`
/// enabled and we keep getting every keystroke echoed back.
///
/// The previous implementation of this helper set termios on the master
/// fd and the bug survived. This version opens the slave fd via
/// `ptsname` and sets `ECHO` off there before the child is spawned —
/// which is what `spawn()`-based TTY frontends (libvte, hyper, iTerm2)
/// all do.
///
/// # Why turning off ECHO is safe
///
///   * Our Composer is the source of user input; we never rely on the
///     shell to display keystrokes back to us.
///   * TUI apps (vim, less, htop) call `tcsetattr(... raw)` themselves
///     when they want total line-discipline control; our change is a
///     no-op for those apps because they overwrite the flags.
///   * Windows ConPTY has no termios concept; the whole helper is gated
///     on `#[cfg(unix)]`, and the caller skips it on Windows.
///
/// Failures are logged but non-fatal — echo comes back, which is
/// better than refusing to spawn a shell.
#[cfg(unix)]
fn disable_echo_on_pty_slave(master_fd: RawFd) -> Result<(), PtyError> {
    use std::ffi::CStr;

    // `ptsname(master_fd)` returns a pointer to a path like `/dev/pts/3`
    // (Linux) or `/dev/ttys005` (macOS). The returned pointer is backed
    // by a statically-allocated buffer in libc and is NOT thread-safe;
    // we copy the string out immediately so nothing else in this
    // process can race us.
    //
    // SAFETY: `master_fd` is a live, owned fd returned by
    // `MasterPty::as_raw_fd()`. `ptsname` reads the kernel's pts mapping
    // for that fd and returns a pointer to its own static storage; we
    // do not outlive that pointer here.
    #[allow(unsafe_code)]
    let slave_path = unsafe {
        let ptr = libc::ptsname(master_fd);
        if ptr.is_null() {
            return Err(PtyError::Spawn(format!(
                "ptsname({master_fd}) returned null: {}",
                std::io::Error::last_os_error()
            )));
        }
        CStr::from_ptr(ptr).to_owned()
    };

    // Open the slave read-write with O_NOCTTY so this open does not
    // steal the slave as our controlling terminal (the child needs to
    // claim it). `open()` on an already-in-use pts is allowed and just
    // returns another fd referencing the same tty struct, so setting
    // termios here propagates to the child.
    //
    // SAFETY: `slave_path.as_ptr()` points into the owned `CString`
    // which lives for the duration of the call.
    #[allow(unsafe_code)]
    let slave_fd = unsafe {
        libc::open(slave_path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY)
    };
    if slave_fd < 0 {
        return Err(PtyError::Spawn(format!(
            "open slave {slave_path:?}: {}",
            std::io::Error::last_os_error()
        )));
    }

    // Ensure the slave fd is closed even if tcsetattr / tcgetattr panic.
    struct AutoClose(RawFd);
    impl Drop for AutoClose {
        fn drop(&mut self) {
            #[allow(unsafe_code)]
            unsafe {
                libc::close(self.0);
            }
        }
    }
    let _guard = AutoClose(slave_fd);

    // SAFETY: `slave_fd` is live until `_guard` drops.
    #[allow(unsafe_code)]
    let borrowed = unsafe { BorrowedFd::borrow_raw(slave_fd) };
    let mut t = tcgetattr(borrowed)
        .map_err(|e| PtyError::Spawn(format!("tcgetattr on pts slave: {e}")))?;
    t.local_flags.remove(
        LocalFlags::ECHO
            | LocalFlags::ECHOE
            | LocalFlags::ECHOK
            | LocalFlags::ECHOKE
            | LocalFlags::ECHOCTL
            | LocalFlags::ECHONL,
    );
    tcsetattr(borrowed, SetArg::TCSANOW, &t)
        .map_err(|e| PtyError::Spawn(format!("tcsetattr on pts slave: {e}")))?;
    Ok(())
}

fn open_blocking(spec: &PtySpec) -> Result<PortablePtyHandle, PtyError> {
    let sys = native_pty_system();
    let pair = sys
        .openpty(PPtySize {
            rows: spec.size.rows,
            cols: spec.size.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| PtyError::Spawn(e.to_string()))?;

    let mut cmd = CommandBuilder::new(&spec.program);
    for a in &spec.args {
        cmd.arg(a);
    }
    if let Some(cwd) = &spec.cwd {
        cmd.cwd(cwd);
    }
    // portable-pty inherits from parent by default; explicit env additions win.
    // NOTE: ADR 0006 mandates scrubbed env for Phase 2. Phase 1 inherits the
    // parent's env unchanged — documented as a known gap.
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    // Disable line-discipline ECHO on the PTY BEFORE spawning the child
    // so the shell inherits a termios with ECHO off. See the full
    // rationale on `disable_echo_on_pty_slave`. The previous
    // implementation set termios on the MASTER fd, which on macOS/Linux
    // is a no-op per `pty(4)` — causing the user-visible "ls → lls"
    // duplication (every character gets doubled because the shell's
    // readline echoes AND the line-discipline echoes). The fix opens
    // the slave via `ptsname` and clears ECHO there.
    //
    // Failures are logged but non-fatal. If the platform doesn't honor
    // the request, the UI sees echoed bytes — ugly but not broken.
    #[cfg(unix)]
    if let Some(fd) = pair.master.as_raw_fd() {
        if let Err(err) = disable_echo_on_pty_slave(fd) {
            tracing::warn!(%err, "portable-pty: failed to disable pty ECHO; echo will appear in block output");
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| PtyError::Spawn(e.to_string()))?;
    // portable-pty docs say to drop the slave fd after spawn to correctly
    // propagate EOF when the child closes.
    drop(pair.slave);

    let pid = child.process_id();
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| PtyError::Spawn(e.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| PtyError::Spawn(e.to_string()))?;

    // Start the dedicated reader thread. It owns the `Read` object and never
    // gives it up — concurrent reads from anywhere else are forbidden.
    let (tx, rx) = sync_channel::<ReadMsg>(READER_CHANNEL_CAPACITY);
    thread::Builder::new()
        .name(format!(
            "quanta-pty-reader-{}",
            pid.map_or_else(|| "?".into(), |p| p.to_string())
        ))
        .spawn(move || reader_thread(reader, &tx))
        .map_err(|e| PtyError::Spawn(format!("reader thread spawn: {e}")))?;

    Ok(PortablePtyHandle {
        master: Arc::new(Mutex::new(Some(pair.master))),
        writer: Arc::new(Mutex::new(Some(writer))),
        child: Arc::new(Mutex::new(Some(child))),
        read_rx: Arc::new(Mutex::new(Some(rx))),
        pid,
        eof: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    })
}

/// Dedicated OS thread that drains the PTY reader. Runs until EOF or the
/// receiver is dropped. Chunks are sized to 8 KiB, matching the session
/// actor's default read chunk.
fn reader_thread(mut reader: Box<dyn Read + Send>, tx: &SyncSender<ReadMsg>) {
    let mut buf = vec![0u8; 8 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                let _ = tx.send(ReadMsg::Eof);
                return;
            }
            Ok(n) => {
                if tx.send(ReadMsg::Bytes(buf[..n].to_vec())).is_err() {
                    // Receiver dropped; stop.
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                // EINTR: retry on next loop iteration.
            }
            Err(e) => {
                let _ = tx.send(ReadMsg::Err(e.to_string()));
                return;
            }
        }
    }
}

/// Concrete [`PtyHandle`] implementation backed by [`portable_pty`].
///
/// Owns the master fd, the writer half, the child process, and the receiver
/// end of the dedicated reader thread. Dropping the handle drops the
/// receiver, which in turn closes the reader thread's tx and triggers its
/// shutdown via the `send` error path.
pub struct PortablePtyHandle {
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
    /// Receiver end of the reader thread's channel. Wrapped in Option so we
    /// can drop it explicitly to signal the reader thread to shut down.
    read_rx: Arc<Mutex<Option<Receiver<ReadMsg>>>>,
    pid: Option<u32>,
    /// Sticky EOF flag. After the reader thread signals EOF we short-circuit
    /// subsequent `read()` calls to return 0 without hitting the channel.
    eof: Arc<std::sync::atomic::AtomicBool>,
}

impl std::fmt::Debug for PortablePtyHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortablePtyHandle")
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl PtyHandle for PortablePtyHandle {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError> {
        use std::sync::atomic::Ordering;
        if self.eof.load(Ordering::Acquire) {
            return Ok(0);
        }
        let rx_arc = self.read_rx.clone();
        let eof_flag = self.eof.clone();
        // The `recv()` is blocking on a std mpsc, so hop to a blocking thread.
        // Unlike the previous implementation, this `recv()` returns promptly
        // when bytes arrive — it does NOT hold any lock across an indefinite
        // PTY syscall. Bytes are already in memory in the channel.
        let msg = tokio::task::spawn_blocking(move || -> Result<ReadMsg, PtyError> {
            let guard = rx_arc
                .lock()
                .expect("pty adapter mutex poisoned (prior task panicked; state unrecoverable)");
            let Some(rx) = guard.as_ref() else {
                return Err(PtyError::Closed);
            };
            // First, drain anything already buffered so we stay at recent-data
            // latency when the producer runs ahead.
            match rx.try_recv() {
                Ok(m) => return Ok(m),
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    eof_flag.store(true, Ordering::Release);
                    return Ok(ReadMsg::Eof);
                }
            }
            // Wait with a short timeout so the async caller can release the
            // outer `Arc<Mutex<Box<dyn PtyHandle>>>` periodically, letting
            // writes/resizes acquire the lock while the PTY has no output
            // ready. Returning an empty buffer surfaces to the session actor
            // as "no new data yet" — it loops back and checks its shutdown
            // signal before issuing the next read.
            //
            // NOTE: this is a pragmatic workaround for the Round 2 port
            // constraint. The real fix is to split `PtyHandle` into reader
            // and writer halves (cross-scope for Round 1).
            match rx.recv_timeout(Duration::from_millis(25)) {
                Ok(m) => Ok(m),
                Err(RecvTimeoutError::Timeout) => Ok(ReadMsg::Bytes(Vec::new())),
                Err(RecvTimeoutError::Disconnected) => {
                    eof_flag.store(true, Ordering::Release);
                    Ok(ReadMsg::Eof)
                }
            }
        })
        .await
        .map_err(|e| PtyError::Io(format!("join error: {e}")))??;

        match msg {
            ReadMsg::Bytes(b) => {
                let n = b.len().min(buf.len());
                buf[..n].copy_from_slice(&b[..n]);
                // `n == 0` here means "internal timeout tick — no data yet,
                // not EOF". The caller should loop, yielding to other tasks.
                Ok(n)
            }
            ReadMsg::Eof => {
                self.eof.store(true, Ordering::Release);
                // Surface EOF as `PtyError::Closed` so the session actor can
                // distinguish it from an empty timeout tick. Historically
                // `Ok(0)` meant EOF in Rust IO; in this adapter we hijack
                // `Ok(0)` to mean "no data right now, keep trying" and use
                // `PtyError::Closed` for true EOF — see the read loop in the
                // session actor.
                Err(PtyError::Closed)
            }
            ReadMsg::Err(e) => Err(PtyError::Io(e)),
        }
    }

    async fn write_all(&mut self, data: &[u8]) -> Result<(), PtyError> {
        let writer = self.writer.clone();
        let owned = data.to_vec();
        tokio::task::spawn_blocking(move || -> Result<(), PtyError> {
            let mut guard = writer
                .lock()
                .expect("pty adapter mutex poisoned (prior task panicked; state unrecoverable)");
            let Some(w) = guard.as_mut() else {
                return Err(PtyError::Closed);
            };
            w.write_all(&owned)
                .map_err(|e| PtyError::Io(e.to_string()))?;
            w.flush().map_err(|e| PtyError::Io(e.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|e| PtyError::Io(format!("join error: {e}")))??;
        Ok(())
    }

    async fn resize(&mut self, size: PtySize) -> Result<(), PtyError> {
        let master = self.master.clone();
        tokio::task::spawn_blocking(move || -> Result<(), PtyError> {
            let guard = master
                .lock()
                .expect("pty adapter mutex poisoned (prior task panicked; state unrecoverable)");
            let Some(m) = guard.as_ref() else {
                return Err(PtyError::Closed);
            };
            m.resize(PPtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Io(e.to_string()))
        })
        .await
        .map_err(|e| PtyError::Io(format!("join error: {e}")))??;
        Ok(())
    }

    async fn wait(&mut self) -> Result<PtyExit, PtyError> {
        let child = self.child.clone();
        let status = tokio::task::spawn_blocking(move || -> Result<PtyExit, PtyError> {
            let mut guard = child
                .lock()
                .expect("pty adapter mutex poisoned (prior task panicked; state unrecoverable)");
            let Some(mut c) = guard.take() else {
                return Err(PtyError::Closed);
            };
            let status = c.wait().map_err(|e| PtyError::Io(e.to_string()))?;
            let exit_code = status.exit_code();
            // portable-pty abstracts signals; we treat nonzero exit_code as the code
            // and leave signal None. Unix details are behind its abstraction.
            // `i32::try_from` is the defensible cast; 128+signal codes stay positive.
            let code = i32::try_from(exit_code).unwrap_or(i32::MAX);
            Ok(PtyExit {
                exit_code: Some(code),
                signal: None,
            })
        })
        .await
        .map_err(|e| PtyError::Io(format!("join error: {e}")))??;
        Ok(status)
    }

    async fn kill(&mut self) -> Result<(), PtyError> {
        let child = self.child.clone();
        tokio::task::spawn_blocking(move || -> Result<(), PtyError> {
            let mut guard = child
                .lock()
                .expect("pty adapter mutex poisoned (prior task panicked; state unrecoverable)");
            let Some(c) = guard.as_mut() else {
                return Ok(());
            };
            c.kill().map_err(|e| PtyError::Io(e.to_string()))
        })
        .await
        .map_err(|e| PtyError::Io(format!("join error: {e}")))??;
        Ok(())
    }

    fn pid(&self) -> Option<u32> {
        self.pid
    }
}

impl Drop for PortablePtyHandle {
    fn drop(&mut self) {
        // Dropping the receiver signals the reader thread to stop. The thread
        // exits once its next `tx.send()` returns Err; in the worst case it
        // is blocked inside `Read::read` at which point we have no graceful
        // way to interrupt and must rely on the OS closing the fd when the
        // master is dropped below.
        if let Ok(mut g) = self.read_rx.lock() {
            let _ = g.take();
        }
        // Drop the master to close the slave fd, which unblocks the reader.
        if let Ok(mut g) = self.master.lock() {
            let _ = g.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawns_echo_and_reads_output() {
        let port = PortablePtyPort::new();
        let spec = PtySpec::shell("/bin/sh")
            .with_arg("-c")
            .with_arg("printf hello");
        let mut h = port.open(spec).await.expect("spawn");
        let mut buf = vec![0u8; 4096];
        let mut collected = Vec::new();
        // Read until EOF or we see 'hello'.
        for _ in 0..50 {
            let n = h.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            collected.extend_from_slice(&buf[..n]);
            if collected.windows(5).any(|w| w == b"hello") {
                break;
            }
        }
        let _ = h.wait().await;
        assert!(
            collected.windows(5).any(|w| w == b"hello"),
            "expected 'hello' in output, got {:?}",
            String::from_utf8_lossy(&collected)
        );
    }
}
