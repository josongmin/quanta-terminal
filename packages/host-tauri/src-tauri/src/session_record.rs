//! Per-session PTY journal (Plan 0005 Epic P1-E).
//!
//! # What this module solves
//!
//! Session restore depends on having every PTY byte a session produced
//! available for deterministic replay on the next boot. This module owns the
//! append-only on-disk format that captures that byte stream.
//!
//! The format is `.qrpl` (Quanta RePLay):
//!
//! ```text
//! +------------------------+
//! |      header (512 B)    |
//! +------------------------+
//! |      frame 0           |
//! |  "FR" | ts32 | len | … |
//! +------------------------+
//! |      frame 1           |
//! +------------------------+
//! |           …            |
//! ```
//!
//! The header is fixed-width so a reader can skip to the frame stream in a
//! single syscall; any extra header fields added in the future slot into the
//! reserved zero-padded tail and bump the `version` field. Frames carry their
//! own length so a writer that is SIGKILL'd mid-frame does not corrupt earlier
//! frames — a replay-side reader detects a short tail and truncates to the
//! last fully-written frame.
//!
//! # Correctness invariants
//!
//! * **Atomic frame writes.** Each `write_frame` call issues a single
//!   `write_all` of the assembled `[magic | ts | len | bytes]` buffer. On all
//!   POSIX filesystems a `write` up to `PIPE_BUF` (4096 B) is atomic; we also
//!   wrap frames > PIPE_BUF in an [`std::io::BufWriter`] and flush per frame
//!   so a `Ctrl-C` mid-write drops the in-flight frame instead of corrupting
//!   the tail of the previous one. The reader-side tail-repair handles the
//!   mid-write case symmetrically.
//! * **Rotation.** When the active file crosses [`ROTATE_BYTES`] (50 MiB), we
//!   rename it to `<session>.1.qrpl` (shifting any existing `.1` → `.2` etc.)
//!   and open a fresh `<session>.qrpl` with the same header. Rotation is
//!   best-effort — a failure to rename falls through to continued appends on
//!   the oversize file so a disk-quota hiccup does not drop bytes.
//! * **Concurrency.** One writer per session is the contract. The writer
//!   struct owns its file handle + buffered writer behind a `Mutex` so
//!   multiple `write_chunk` calls from different threads (the PTY reader
//!   thread + test threads) serialise cleanly.
//! * **Fsync on close.** `stop()` flushes the `BufWriter` then fsyncs the
//!   underlying fd so the tail reaches disk before the process exits. On
//!   graceful shutdown this closes the window where a kernel page cache flush
//!   has not yet happened.
//!
//! # Out of scope
//!
//! * Block-level metadata (block-start / block-end) is a P1-A + P1-C concern.
//! * Cross-machine sync / encryption / redaction: see P1-E plan. This module
//!   is the storage substrate only.

// The reader-side APIs (`FrameReader`, `open_for_replay`, `read_header`,
// `rotated_paths`) are consumed by the TS replay path over the filesystem —
// there is no Rust caller today, but they ship in this module because the
// on-disk format is defined here and we want a single place to update when
// the format changes. Tests exercise all of them, so they are not truly dead.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;

/// `.qrpl` file magic. Eight bytes so the header alignment stays tidy.
pub const MAGIC: &[u8; 8] = b"QRPL\0\0\0\0";

/// Current on-disk schema version. Replayers MUST refuse unknown (higher)
/// versions; older versions surface a user-facing banner ("journal migrated —
/// tail truncated"). See P1-E plan for the compat story.
pub const JOURNAL_VERSION: u32 = 1;

/// Fixed header length. Padded with zeros past the last declared field so
/// additive future fields do not change the frame offset.
pub const HEADER_LEN: usize = 512;

/// Frame record magic — ASCII "FR". Distinct from the file magic so a reader
/// aligned one byte off will fail the check instead of silently reading a
/// garbage frame.
pub const FRAME_MAGIC: &[u8; 2] = b"FR";

/// Frame header bytes: magic(2) + ts(4) + chunk_len(4).
pub const FRAME_HEADER_LEN: usize = 2 + 4 + 4;

/// Rotate the active file after it crosses this many bytes.
pub const ROTATE_BYTES: u64 = 50 * 1024 * 1024;

/// Max rotated tail to keep. Older rotations are deleted.
pub const MAX_ROTATIONS: u32 = 4;

/// Problem cases the writer surfaces. We do not bubble IO errors through the
/// PTY data-plane (a journal write failure must never drop PTY bytes to the
/// UI), but the IPC start/stop commands propagate a typed error so the TS
/// side can surface a one-shot banner.
#[derive(Debug, thiserror::Error)]
pub enum JournalError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("header: {0}")]
    Header(&'static str),
    #[error("bad session id: {0}")]
    SessionId(String),
    #[error("journal directory resolution failed: {0}")]
    DirResolve(String),
}

/// Per-session journal writer.
///
/// Cheap to clone (wraps an `Arc<Mutex<…>>`). The IPC layer holds one handle
/// per session in `AppState`; the PTY reader thread calls
/// [`SessionJournal::write_chunk`] for every chunk emitted to the UI.
#[derive(Clone)]
pub struct SessionJournal {
    inner: Arc<Mutex<JournalInner>>,
}

struct JournalInner {
    /// Directory the journal lives in — we keep this around so we can
    /// re-open after a rotation without resolving the config dir again.
    dir: PathBuf,
    /// Base name: `<session_id>.qrpl`. Rotations append `.N` suffixes.
    base: String,
    /// Monotonic createdAt (relative offset anchor for frame timestamps).
    created_at_ms: i64,
    /// Buffered writer on the current active file. Wrapped so frame writes
    /// do not issue a syscall per frame — we flush explicitly on `stop()`
    /// and every `write_chunk` to keep the tail survivable under Ctrl-C.
    writer: BufWriter<File>,
    /// Running byte count for the current file (header + frames).
    bytes_written: u64,
}

impl SessionJournal {
    /// Open (or create) a journal for `session_id` under `dir`.
    ///
    /// Writes the 512 B header immediately; subsequent `write_chunk` calls
    /// append frame records. The `shell` + `cwd` fields are truncated to
    /// their on-disk fixed widths so a very long cwd does not extend the
    /// header past 512 B.
    pub fn open(
        dir: &Path,
        session_id: &str,
        cols: u16,
        rows: u16,
        shell: &str,
        cwd: &str,
    ) -> Result<Self, JournalError> {
        if session_id.is_empty()
            || session_id.len() > 128
            || session_id
                .chars()
                .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        {
            return Err(JournalError::SessionId(session_id.to_string()));
        }
        std::fs::create_dir_all(dir)?;
        let base = format!("{session_id}.qrpl");
        let active = dir.join(&base);
        let created_at_ms = now_ms();
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&active)?;
        let header = build_header(cols, rows, created_at_ms, shell, cwd);
        file.write_all(&header)?;
        file.sync_data().ok();
        let writer = BufWriter::new(file);
        let inner = JournalInner {
            dir: dir.to_path_buf(),
            base,
            created_at_ms,
            writer,
            bytes_written: HEADER_LEN as u64,
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
        })
    }

    /// Append a single chunk as a frame record.
    ///
    /// Never rejects on transient IO error — the caller (PTY pump) must not
    /// drop UI bytes because of a journal hiccup. Errors are logged and the
    /// next call retries. Rotations happen transparently inside this call.
    pub fn write_chunk(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut inner = self.inner.lock();
        let now = now_ms();
        let ts_rel = now
            .saturating_sub(inner.created_at_ms)
            .clamp(0, u32::MAX as i64) as u32;
        if let Err(err) = inner.append_frame(ts_rel, bytes) {
            tracing::warn!(?err, "session_record: append_frame failed; dropping");
        }
        if inner.bytes_written >= ROTATE_BYTES {
            if let Err(err) = inner.rotate() {
                tracing::warn!(?err, "session_record: rotate failed; continuing on oversize file");
            }
        }
    }

    /// Flush + fsync. Idempotent; calling `stop` twice is a no-op on the
    /// second call because the flush is a no-op when the buffer is empty.
    pub fn stop(&self) -> Result<(), JournalError> {
        let mut inner = self.inner.lock();
        inner.writer.flush()?;
        inner.writer.get_ref().sync_all()?;
        Ok(())
    }
}

impl JournalInner {
    fn append_frame(&mut self, ts_rel: u32, chunk: &[u8]) -> Result<(), JournalError> {
        let chunk_len: u32 = chunk
            .len()
            .try_into()
            .map_err(|_| JournalError::Header("chunk > u32"))?;
        let mut buf = Vec::with_capacity(FRAME_HEADER_LEN + chunk.len());
        buf.extend_from_slice(FRAME_MAGIC);
        buf.extend_from_slice(&ts_rel.to_le_bytes());
        buf.extend_from_slice(&chunk_len.to_le_bytes());
        buf.extend_from_slice(chunk);
        // Single write_all keeps the atom boundary aligned to frame start;
        // flushing per frame survives Ctrl-C by leaving either a whole frame
        // on disk or a short tail the replayer truncates.
        self.writer.write_all(&buf)?;
        self.writer.flush()?;
        self.bytes_written = self.bytes_written.saturating_add(buf.len() as u64);
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), JournalError> {
        // Close the current writer first. We drop + reopen rather than
        // seeking the same handle so a replayer that opens the old file
        // during rotation sees a consistent tail.
        self.writer.flush()?;
        self.writer.get_ref().sync_all()?;
        // Cascade: .N → .(N+1), ..., .1 → .2. Any missing intermediate slot
        // is fine; `rename` on a nonexistent source returns NotFound and we
        // swallow that case.
        for n in (1..=MAX_ROTATIONS).rev() {
            let src = self.dir.join(format!("{}.{}", self.base, n));
            if n == MAX_ROTATIONS && src.exists() {
                let _ = std::fs::remove_file(&src);
                continue;
            }
            let dst = self.dir.join(format!("{}.{}", self.base, n + 1));
            if src.exists() {
                std::fs::rename(&src, &dst)?;
            }
        }
        let active = self.dir.join(&self.base);
        let rotated = self.dir.join(format!("{}.1", self.base));
        std::fs::rename(&active, &rotated)?;
        // Fresh active file with the same header so each rotation is
        // self-describing: a replayer opening `<id>.1.qrpl` or `<id>.qrpl`
        // reads identical createdAt / cols / rows metadata.
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&active)?;
        let header = current_header_for_rotation(self);
        let mut writer = BufWriter::new(file);
        writer.write_all(&header)?;
        writer.flush()?;
        writer.get_ref().sync_data().ok();
        self.writer = writer;
        self.bytes_written = HEADER_LEN as u64;
        Ok(())
    }
}

fn current_header_for_rotation(inner: &JournalInner) -> [u8; HEADER_LEN] {
    // We cannot recover the original cols/rows/shell/cwd from the old file
    // cheaply here — re-read the original header's first bytes. In practice
    // the rotation callsite is inside write_chunk, which does not have those
    // values handy, so we preserve them by copying from the rotated file.
    let rotated_path = inner.dir.join(format!("{}.1", inner.base));
    if let Ok(mut f) = File::open(&rotated_path) {
        let mut buf = [0u8; HEADER_LEN];
        if f.read_exact(&mut buf).is_ok() && &buf[0..8] == MAGIC {
            return buf;
        }
    }
    // Defensive fallback: a minimally-valid header. Real replayers will
    // surface "journal header mismatch" if a rotation ever hits this path,
    // but the frame stream itself stays parseable.
    build_header(
        80,
        24,
        inner.created_at_ms,
        "unknown",
        "",
    )
}

/// Build a 512 B header. Over-long strings are truncated to the on-disk
/// fixed width so the total stays exactly 512 B.
pub fn build_header(cols: u16, rows: u16, created_at_ms: i64, shell: &str, cwd: &str) -> [u8; HEADER_LEN] {
    let mut out = [0u8; HEADER_LEN];
    out[0..8].copy_from_slice(MAGIC);
    out[8..12].copy_from_slice(&JOURNAL_VERSION.to_le_bytes());
    out[12..16].copy_from_slice(&(cols as u32).to_le_bytes());
    out[16..20].copy_from_slice(&(rows as u32).to_le_bytes());
    out[20..28].copy_from_slice(&created_at_ms.to_le_bytes());
    let shell_bytes = shell.as_bytes();
    let shell_n = shell_bytes.len().min(32);
    out[28..28 + shell_n].copy_from_slice(&shell_bytes[..shell_n]);
    let cwd_bytes = cwd.as_bytes();
    let cwd_n = cwd_bytes.len().min(256);
    out[60..60 + cwd_n].copy_from_slice(&cwd_bytes[..cwd_n]);
    // Remaining 512 - 316 = 196 bytes stay zero for future fields.
    out
}

/// Parsed header values — returned by [`read_header`] so callers can
/// validate before replay.
#[derive(Debug, Clone)]
pub struct JournalHeader {
    pub version: u32,
    pub cols: u16,
    pub rows: u16,
    pub created_at_ms: i64,
    pub shell: String,
    pub cwd: String,
}

/// Parse a 512 B header, validating the magic + version.
pub fn read_header(bytes: &[u8]) -> Result<JournalHeader, JournalError> {
    if bytes.len() < HEADER_LEN {
        return Err(JournalError::Header("short header"));
    }
    if &bytes[0..8] != MAGIC {
        return Err(JournalError::Header("bad magic"));
    }
    let version = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    if version == 0 || version > JOURNAL_VERSION {
        return Err(JournalError::Header("unsupported version"));
    }
    let cols = u32::from_le_bytes(bytes[12..16].try_into().unwrap()).min(u16::MAX as u32) as u16;
    let rows = u32::from_le_bytes(bytes[16..20].try_into().unwrap()).min(u16::MAX as u32) as u16;
    let created_at_ms = i64::from_le_bytes(bytes[20..28].try_into().unwrap());
    let shell = cstr_from_fixed(&bytes[28..60]);
    let cwd = cstr_from_fixed(&bytes[60..316]);
    Ok(JournalHeader {
        version,
        cols,
        rows,
        created_at_ms,
        shell,
        cwd,
    })
}

fn cstr_from_fixed(region: &[u8]) -> String {
    let end = region.iter().position(|&b| b == 0).unwrap_or(region.len());
    String::from_utf8_lossy(&region[..end]).into_owned()
}

/// Resolve the default journal directory (`~/.config/quanta/session-restore/`).
///
/// The production caller passes in an explicit path (Tauri's
/// `app_config_dir()` is the canonical location); this helper is the fallback
/// for tests / CLI tools that do not have an `AppHandle` handy.
pub fn default_journal_dir() -> Result<PathBuf, JournalError> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| JournalError::DirResolve("no HOME".into()))?;
    Ok(PathBuf::from(home).join(".config/quanta/session-restore"))
}

/// Path to the active journal for a session under `dir`.
pub fn journal_path(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("{session_id}.qrpl"))
}

/// Low-level reader — iterates frames from a fully-written journal. Stops at
/// EOF or on a short (partially-written) frame; the latter is NOT an error so
/// a reader can restore a session whose writer was SIGKILL'd.
pub struct FrameReader<R: Read> {
    r: R,
    /// Monotonic byte cursor for logging / tests.
    pos: u64,
}

/// One parsed frame. `bytes` is the chunk payload.
#[derive(Debug)]
pub struct Frame {
    pub ts_ms: u32,
    pub bytes: Vec<u8>,
}

impl<R: Read> FrameReader<R> {
    pub fn new(r: R) -> Self {
        Self { r, pos: 0 }
    }

    /// Read the next frame, returning `Ok(None)` on clean EOF AND on a short
    /// tail (a writer that crashed mid-frame). The caller treats both cases
    /// identically — "no more playable data".
    pub fn next_frame(&mut self) -> Result<Option<Frame>, JournalError> {
        let mut hdr = [0u8; FRAME_HEADER_LEN];
        match read_exact_or_short(&mut self.r, &mut hdr) {
            Ok(true) => {}
            Ok(false) => return Ok(None),
            Err(e) => return Err(JournalError::Io(e)),
        }
        if &hdr[0..2] != FRAME_MAGIC {
            // Out-of-sync: treat as end-of-stream. A corrupt middle frame
            // truncates replay to what we have so far.
            return Ok(None);
        }
        let ts_ms = u32::from_le_bytes(hdr[2..6].try_into().unwrap());
        let chunk_len = u32::from_le_bytes(hdr[6..10].try_into().unwrap()) as usize;
        // 64 MiB sanity cap per frame — real PTY chunks are < 64 KiB. A
        // chunk_len larger than this is evidence of bit-flip corruption and
        // we truncate replay rather than trust the value.
        if chunk_len > 64 * 1024 * 1024 {
            return Ok(None);
        }
        let mut payload = vec![0u8; chunk_len];
        match read_exact_or_short(&mut self.r, &mut payload) {
            Ok(true) => {}
            Ok(false) => return Ok(None),
            Err(e) => return Err(JournalError::Io(e)),
        }
        self.pos = self
            .pos
            .saturating_add((FRAME_HEADER_LEN + chunk_len) as u64);
        Ok(Some(Frame {
            ts_ms,
            bytes: payload,
        }))
    }
}

fn read_exact_or_short<R: Read>(r: &mut R, buf: &mut [u8]) -> std::io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => return Ok(false),
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

/// Open the active journal + seek past the header so a caller can iterate
/// with [`FrameReader::next_frame`]. Does not look at rotated tails; the
/// replay engine chains them explicitly via [`rotated_paths`].
pub fn open_for_replay(path: &Path) -> Result<(JournalHeader, File), JournalError> {
    let mut f = File::open(path)?;
    let mut hdr = [0u8; HEADER_LEN];
    f.read_exact(&mut hdr)?;
    let header = read_header(&hdr)?;
    f.seek(SeekFrom::Start(HEADER_LEN as u64))?;
    Ok((header, f))
}

/// Enumerate rotated files for `session_id` under `dir`, newest-first. The
/// active `.qrpl` is listed last so iterating left-to-right replays oldest →
/// newest.
pub fn rotated_paths(dir: &Path, session_id: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for n in (1..=MAX_ROTATIONS).rev() {
        let p = dir.join(format!("{session_id}.qrpl.{n}"));
        if p.exists() {
            out.push(p);
        }
    }
    let active = dir.join(format!("{session_id}.qrpl"));
    if active.exists() {
        out.push(active);
    }
    out
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn header_is_exactly_512_bytes() {
        let h = build_header(80, 24, 1_700_000_000_000, "/bin/zsh", "/Users/alice");
        assert_eq!(h.len(), HEADER_LEN);
        // Magic present
        assert_eq!(&h[0..8], MAGIC);
        // Version serialises LE
        let v = u32::from_le_bytes(h[8..12].try_into().unwrap());
        assert_eq!(v, JOURNAL_VERSION);
    }

    #[test]
    fn roundtrip_single_frame() {
        let dir = make_dir();
        let j = SessionJournal::open(dir.path(), "abc-123", 80, 24, "/bin/zsh", "/tmp").unwrap();
        j.write_chunk(b"hello world");
        j.stop().unwrap();

        let path = journal_path(dir.path(), "abc-123");
        let (hdr, file) = open_for_replay(&path).expect("open");
        assert_eq!(hdr.version, JOURNAL_VERSION);
        assert_eq!(hdr.cols, 80);
        assert_eq!(hdr.rows, 24);
        assert_eq!(hdr.shell, "/bin/zsh");
        assert_eq!(hdr.cwd, "/tmp");
        let mut rdr = FrameReader::new(file);
        let f = rdr.next_frame().unwrap().expect("frame");
        assert_eq!(f.bytes, b"hello world");
        assert!(rdr.next_frame().unwrap().is_none());
    }

    #[test]
    fn multiple_frames_preserve_order_and_bytes() {
        let dir = make_dir();
        let j = SessionJournal::open(dir.path(), "s", 100, 40, "sh", "").unwrap();
        let payloads: Vec<Vec<u8>> = (0..16)
            .map(|i| format!("chunk-{i}-{}", "x".repeat(i * 3)).into_bytes())
            .collect();
        for p in &payloads {
            j.write_chunk(p);
        }
        j.stop().unwrap();
        let (_hdr, f) = open_for_replay(&journal_path(dir.path(), "s")).unwrap();
        let mut rdr = FrameReader::new(f);
        for expected in &payloads {
            let frame = rdr.next_frame().unwrap().expect("frame");
            assert_eq!(&frame.bytes, expected);
        }
        assert!(rdr.next_frame().unwrap().is_none());
    }

    #[test]
    fn short_tail_truncates_cleanly() {
        // Simulate a SIGKILL mid-frame by truncating the file mid-payload.
        let dir = make_dir();
        let j = SessionJournal::open(dir.path(), "crash", 80, 24, "sh", "").unwrap();
        j.write_chunk(b"first ");
        j.write_chunk(b"second chunk that is longer");
        j.stop().unwrap();
        let path = journal_path(dir.path(), "crash");
        let full_len = std::fs::metadata(&path).unwrap().len();
        // Chop 5 bytes off — inside the second frame's payload.
        let f = OpenOptions::new().write(true).open(&path).unwrap();
        f.set_len(full_len - 5).unwrap();
        drop(f);

        let (_hdr, f) = open_for_replay(&path).unwrap();
        let mut rdr = FrameReader::new(f);
        let f0 = rdr.next_frame().unwrap().expect("first frame");
        assert_eq!(f0.bytes, b"first ");
        // Second frame: short tail → None, not a panic.
        let f1 = rdr.next_frame().unwrap();
        assert!(f1.is_none(), "expected short tail to be None");
    }

    #[test]
    fn bad_magic_rejected() {
        let mut h = build_header(80, 24, 0, "sh", "");
        h[0] = b'X';
        assert!(read_header(&h).is_err());
    }

    #[test]
    fn version_higher_than_current_rejected() {
        let mut h = build_header(80, 24, 0, "sh", "");
        h[8..12].copy_from_slice(&(JOURNAL_VERSION + 1).to_le_bytes());
        assert!(read_header(&h).is_err());
    }

    #[test]
    fn concurrent_writes_are_serialised() {
        use std::thread;
        let dir = make_dir();
        let j = SessionJournal::open(dir.path(), "par", 80, 24, "sh", "").unwrap();
        let mut handles = Vec::new();
        for t in 0..8 {
            let j2 = j.clone();
            handles.push(thread::spawn(move || {
                for i in 0..20 {
                    let payload = format!("t{t}-i{i}").into_bytes();
                    j2.write_chunk(&payload);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        j.stop().unwrap();

        // Every frame we read must pass the magic check AND be one of the
        // expected payload shapes. Order across threads is undefined but
        // each frame is whole — no torn writes.
        let (_hdr, f) = open_for_replay(&journal_path(dir.path(), "par")).unwrap();
        let mut rdr = FrameReader::new(f);
        let mut count = 0usize;
        while let Some(frame) = rdr.next_frame().unwrap() {
            let s = std::str::from_utf8(&frame.bytes).expect("utf8");
            assert!(s.starts_with('t'), "unexpected frame payload {s:?}");
            count += 1;
        }
        assert_eq!(count, 8 * 20);
    }

    #[test]
    fn rotation_moves_oversize_file_to_dot_one() {
        // Drive rotation by inlining a tiny rotate bound into this test via
        // a large-ish write. We don't dynamically reconfigure ROTATE_BYTES;
        // instead we prove the rotate() method itself works end-to-end by
        // invoking it through the writer state machine.
        let dir = make_dir();
        let j = SessionJournal::open(dir.path(), "rot", 80, 24, "sh", "").unwrap();
        {
            // Force rotation via the internal path by crossing the threshold
            // with a single large write (≥ ROTATE_BYTES bytes of payload).
            // Use 256 KiB chunks to keep the test fast.
            let chunk = vec![b'A'; 256 * 1024];
            let iterations = (ROTATE_BYTES / chunk.len() as u64) + 2;
            for _ in 0..iterations {
                j.write_chunk(&chunk);
            }
        }
        j.stop().unwrap();

        let active = journal_path(dir.path(), "rot");
        let rotated = dir.path().join("rot.qrpl.1");
        assert!(active.exists(), "active file after rotation");
        assert!(rotated.exists(), "rotated .1 file exists");

        // Active file begins with a fresh header.
        let (hdr, _f) = open_for_replay(&active).unwrap();
        assert_eq!(hdr.version, JOURNAL_VERSION);
    }

    #[test]
    fn rejects_bad_session_id() {
        let dir = make_dir();
        assert!(
            SessionJournal::open(dir.path(), "../escape", 80, 24, "sh", "").is_err(),
            "path traversal id rejected"
        );
        assert!(SessionJournal::open(dir.path(), "", 80, 24, "sh", "").is_err());
    }

    #[test]
    fn long_cwd_is_truncated_to_fit_header() {
        let long = "x".repeat(10_000);
        let h = build_header(80, 24, 0, "sh", &long);
        assert_eq!(h.len(), HEADER_LEN);
        let parsed = read_header(&h).unwrap();
        assert_eq!(parsed.cwd.len(), 256);
    }

    #[test]
    fn rotated_paths_are_chronological() {
        let dir = make_dir();
        // Simulate an existing rotated layout.
        for name in [
            "s.qrpl",
            "s.qrpl.1",
            "s.qrpl.2",
        ] {
            std::fs::write(dir.path().join(name), b"stub").unwrap();
        }
        let paths = rotated_paths(dir.path(), "s");
        assert_eq!(paths.len(), 3);
        // Oldest (.2) first, active last.
        assert!(paths[0].to_string_lossy().ends_with("s.qrpl.2"));
        assert!(paths[1].to_string_lossy().ends_with("s.qrpl.1"));
        assert!(paths[2].to_string_lossy().ends_with("s.qrpl"));
    }
}
