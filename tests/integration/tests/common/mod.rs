#![allow(
    clippy::large_enum_variant,
    reason = "Frame is a short-lived test utility; boxing adds noise to test code."
)]
#![allow(
    clippy::needless_continue,
    reason = "explicit `continue` documents the branching in the frame dispatch loop."
)]

//! Shared helpers for the integration harness.
//!
//! The `MockHost` exists because the real wire protocol is two planes —
//! newline-delimited JSON control frames and MessagePack event frames — sharing
//! one Unix socket with a 1-byte channel tag (see `quanta-protocol/src/adapters/unix_socket.rs`).
//! Tests need a small, honest client that speaks that exact framing; this
//! module IS that client.
//!
//! Design notes:
//!   - We intentionally parse the stream byte-by-byte so the tests fail on
//!     real framing bugs rather than papering over them with a tolerant reader.
//!   - `recv_with_deadline` never blocks indefinitely; every call has a
//!     deadline so a hung server shows up as a clean timeout, not a hung CI.
//!   - The client is a newtype wrapper over `tokio::net::UnixStream`; we do
//!     not bring in `tonic` or other heavy RPC stacks because the integration
//!     scope here is specifically about the bespoke framing contract.
//!
//! This module is consumed with `mod common;` at the top of every test file.
//! That produces `Cargo` warnings for helpers any one test binary happens not
//! to use, and for the `pub` visibility Cargo expects on cross-file helpers
//! even though the workspace's `unreachable_pub = "warn"` lint complains.
//! Both are irrelevant inside an integration harness, so they are silenced
//! at module scope.

#![allow(dead_code)]
#![allow(unreachable_pub)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::ids::SessionId;
use quanta_proto::protocol::{Hello, ProtocolVersion, Ready};
use quanta_proto::rpc::{
    CancelBlock, CloseSession, CreateSession, CreateSessionResult, InputMode, ListSessions,
    RpcError, RpcMethod, RpcRequest, RpcResponse, RpcResult, SubmitInput, SubmitInputResult,
};
use quanta_protocol::{decode_control, encode_control, ControlMessage};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};

/// Channel markers, matching `quanta-protocol/src/adapters/unix_socket.rs`.
/// Duplicated here instead of imported because they are private to the
/// adapter; copying them keeps this harness honest if the adapter changes.
pub const CHANNEL_CONTROL: u8 = 0x01;
pub const CHANNEL_EVENT: u8 = 0x02;

/// Locate the `quanta-core` binary that Cargo just built for us.
///
/// Cargo sets `CARGO_BIN_EXE_<name>` for every binary dep listed under
/// `[dev-dependencies]`. We rely on that convention rather than hard-coding
/// `target/debug/…` — that way the test also works under `cargo test --release`
/// and under an alternate target triple.
///
/// If the env var is missing (e.g. when the crate is built via `rustc`
/// directly in a non-Cargo context), we fall back to walking up from
/// `CARGO_MANIFEST_DIR` to the workspace `target/` directory.
pub fn quanta_core_bin() -> PathBuf {
    // Primary: Cargo-assigned path if `quanta-core` is in `[dev-dependencies]`.
    if let Some(p) = option_env!("CARGO_BIN_EXE_quanta-core") {
        return PathBuf::from(p);
    }
    // Fallback: derive from this crate's manifest dir.
    let manifest = env!("CARGO_MANIFEST_DIR");
    let workspace_root = Path::new(manifest)
        .parent()
        .and_then(Path::parent)
        .expect("workspace root");
    workspace_root
        .join("target")
        .join("debug")
        .join("quanta-core")
}

/// A launched `quanta-core` child bound to a temp profile + temp socket. The
/// struct holds the `TempDir` so its lifetime is pinned to the child's.
pub struct CoreProcess {
    pub child: Child,
    pub socket_path: PathBuf,
    pub _profile: TempDir,
}

impl CoreProcess {
    /// Spawn the binary and wait for the socket to appear.
    ///
    /// Deadline of 5 s is generous: a cold-boot debug build with zstd/rusqlite
    /// typically finishes `Engine::boot` in well under 200 ms.
    pub async fn spawn() -> Result<Self> {
        let profile = TempDir::new().context("profile dir")?;
        let socket_path = profile.path().join("sock");
        let bin = quanta_core_bin();
        if !bin.exists() {
            bail!(
                "quanta-core binary not found at {:?}; run `cargo build -p quanta-core` first",
                bin
            );
        }
        let child = Command::new(&bin)
            .arg("--socket")
            .arg(&socket_path)
            .arg("--profile")
            .arg(profile.path())
            // Keep the sidecar logs visible on CI failures without piping
            // them through our stdout (which would interleave with test output).
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("RUST_LOG", "warn")
            .kill_on_drop(true)
            .spawn()
            .context("spawn quanta-core")?;

        let deadline = Instant::now() + Duration::from_secs(5);
        while !socket_path.exists() {
            if Instant::now() >= deadline {
                bail!("quanta-core did not bind socket within 5s");
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok(Self {
            child,
            socket_path,
            _profile: profile,
        })
    }

    /// Connect a `MockHost` to the live socket and perform the handshake.
    pub async fn connect(&self) -> Result<MockHost> {
        MockHost::connect(&self.socket_path).await
    }

    /// Best-effort shutdown. Called automatically on drop via `kill_on_drop`,
    /// but explicit calls in tests improve error reporting.
    pub async fn shutdown(mut self) -> Result<()> {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        Ok(())
    }
}

/// A mock host that speaks the real wire protocol to `quanta-core`.
pub struct MockHost {
    stream: UnixStream,
    /// Rolling read buffer. Control lines and event frames both land here and
    /// are dispatched on a per-frame basis by `recv_once`.
    buf: Vec<u8>,
    /// `request_id` counter, monotonic per client.
    next_req_id: u64,
    /// Events seen while the client was awaiting an RPC response. `rpc()`
    /// used to silently drop these; we now stash them here so
    /// `collect_events_until` can return them in correct order. Without this,
    /// early events (`SessionCreated`, `BlockCreated`, `BlockStarted`,
    /// `InputSubmitted`) are observed missing because they land between the
    /// `SubmitInput` RPC's request and its response.
    event_backlog: std::collections::VecDeque<Envelope<Event>>,
}

#[derive(Debug)]
pub enum Frame {
    Control(ControlMessage),
    Event(Envelope<Event>),
}

impl MockHost {
    pub async fn connect(sock: &Path) -> Result<Self> {
        Self::connect_with_resume(sock, std::collections::HashMap::new()).await
    }

    /// Variant used by the resume-cursor integration test.
    pub async fn connect_with_resume(
        sock: &Path,
        resume_cursors: std::collections::HashMap<String, u64>,
    ) -> Result<Self> {
        let stream = UnixStream::connect(sock).await.context("connect")?;
        let mut host = Self {
            stream,
            buf: Vec::with_capacity(8192),
            next_req_id: 0,
            event_backlog: std::collections::VecDeque::new(),
        };
        host.handshake_with_resume(resume_cursors).await?;
        Ok(host)
    }

    async fn handshake_with_resume(
        &mut self,
        resume_cursors: std::collections::HashMap<String, u64>,
    ) -> Result<Ready> {
        let hello = Hello {
            host_protocol_version: ProtocolVersion::CURRENT,
            host_version: "integration-test-0.0.0".into(),
            client_id: "integration-mock".into(),
            resume_cursors,
        };
        self.send_control(&ControlMessage::Hello(hello)).await?;
        // Response may be preceded by NO events (nothing buffered before
        // handshake), so the first control frame we see is Ready or
        // Incompatible.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if Instant::now() >= deadline {
                bail!("handshake timed out waiting for Ready");
            }
            match self.recv_once(Some(deadline)).await? {
                Frame::Control(ControlMessage::Ready(r)) => return Ok(r),
                Frame::Control(ControlMessage::Incompatible(inc)) => {
                    bail!("handshake rejected: {}", inc.reason)
                }
                Frame::Control(other) => {
                    bail!("unexpected control during handshake: {:?}", other)
                }
                Frame::Event(_) => {
                    // Events before Ready are a protocol violation today; log
                    // and continue so the timeout fires cleanly.
                    continue;
                }
            }
        }
    }

    /// Encode and send a control frame.
    pub async fn send_control(&mut self, msg: &ControlMessage) -> Result<()> {
        let body = encode_control(msg).map_err(|e| anyhow!("encode: {e}"))?;
        self.stream
            .write_all(&[CHANNEL_CONTROL])
            .await
            .context("write channel byte")?;
        self.stream.write_all(&body).await.context("write body")?;
        self.stream.flush().await.context("flush")?;
        Ok(())
    }

    /// Send a typed RPC and await the matching `RpcResponse`.
    pub async fn rpc(&mut self, method: RpcMethod) -> Result<RpcResponse<serde_json::Value>> {
        self.next_req_id += 1;
        let request_id = format!("req-{}", self.next_req_id);
        let msg = ControlMessage::Request(RpcRequest {
            request_id: request_id.clone(),
            payload: method,
        });
        self.send_control(&msg).await?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() >= deadline {
                bail!("rpc({request_id}) timed out after 5s");
            }
            match self.recv_once(Some(deadline)).await? {
                Frame::Control(ControlMessage::Response(resp)) => {
                    if resp.request_id == request_id {
                        return Ok(resp);
                    }
                    // Unmatched request id = server bug; surface it.
                    bail!(
                        "response request_id mismatch: got {}, want {}",
                        resp.request_id,
                        request_id
                    );
                }
                Frame::Control(_other) => continue,
                Frame::Event(env) => {
                    // Stash instead of dropping — the test may want these
                    // later via `collect_events_until`.
                    self.event_backlog.push_back(env);
                    continue;
                }
            }
        }
    }

    /// RPC helper: `create_session` with the given shell/cwd.
    pub async fn create_session(
        &mut self,
        shell: &str,
        cwd: Option<&Path>,
    ) -> Result<CreateSessionResult> {
        let resp = self
            .rpc(RpcMethod::CreateSession(CreateSession {
                shell: Some(shell.to_string()),
                cwd: cwd.map(|p| p.to_string_lossy().into_owned()),
                cols: 80,
                rows: 24,
            }))
            .await?;
        result_ok::<CreateSessionResult>(resp)
    }

    /// RPC helper: submit input as a full command.
    pub async fn submit(&mut self, session_id: SessionId, text: &str) -> Result<SubmitInputResult> {
        let resp = self
            .rpc(RpcMethod::SubmitInput(SubmitInput {
                session_id,
                text: text.into(),
                mode: InputMode::Submit,
            }))
            .await?;
        result_ok::<SubmitInputResult>(resp)
    }

    pub async fn cancel(
        &mut self,
        session_id: SessionId,
        block_id: quanta_proto::ids::BlockId,
    ) -> Result<()> {
        let resp = self
            .rpc(RpcMethod::CancelBlock(CancelBlock {
                session_id,
                block_id,
            }))
            .await?;
        let _: serde_json::Value = result_ok(resp)?;
        Ok(())
    }

    pub async fn close_session(&mut self, session_id: SessionId) -> Result<()> {
        let resp = self
            .rpc(RpcMethod::CloseSession(CloseSession { session_id }))
            .await?;
        let _: serde_json::Value = result_ok(resp)?;
        Ok(())
    }

    pub async fn list_sessions(&mut self) -> Result<RpcResponse<serde_json::Value>> {
        self.rpc(RpcMethod::ListSessions(ListSessions)).await
    }

    /// Drain events until `pred` returns true on the collected vec, or the
    /// overall deadline passes. Returns the full list of events seen.
    pub async fn collect_events_until<F>(
        &mut self,
        pred: F,
        overall: Duration,
    ) -> Result<Vec<Envelope<Event>>>
    where
        F: Fn(&[Envelope<Event>]) -> bool,
    {
        let mut events = Vec::new();
        // Drain the backlog first — events queued during prior RPC waits.
        while let Some(env) = self.event_backlog.pop_front() {
            events.push(env);
            if pred(&events) {
                return Ok(events);
            }
        }
        let deadline = Instant::now() + overall;
        while Instant::now() < deadline {
            match self.recv_once(Some(deadline)).await {
                Ok(Frame::Event(env)) => {
                    events.push(env);
                    if pred(&events) {
                        return Ok(events);
                    }
                }
                Ok(Frame::Control(_)) => continue,
                Err(e) => {
                    if pred(&events) {
                        return Ok(events);
                    }
                    return Err(e);
                }
            }
        }
        Ok(events)
    }

    /// Read exactly one frame off the wire. Honours the optional deadline.
    pub async fn recv_once(&mut self, deadline: Option<Instant>) -> Result<Frame> {
        loop {
            if let Some(frame) = self.try_take()? {
                return Ok(frame);
            }
            let mut tmp = [0u8; 8192];
            let remaining = deadline
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_secs(5));
            if remaining.is_zero() {
                bail!("read timed out");
            }
            let n = tokio::time::timeout(remaining, self.stream.read(&mut tmp))
                .await
                .map_err(|_| anyhow!("read deadline exceeded"))?
                .context("socket read")?;
            if n == 0 {
                bail!("server closed connection");
            }
            self.buf.extend_from_slice(&tmp[..n]);
        }
    }

    /// Attempt to dequeue a complete frame from the buffered bytes.
    ///
    /// The server interleaves control frames (0x01 + JSON + '\n') and event
    /// frames (0x02 + u32be length + MessagePack body). This dispatcher peeks
    /// the channel byte, confirms the frame is whole, and hands off to the
    /// per-plane parser.
    fn try_take(&mut self) -> Result<Option<Frame>> {
        if self.buf.is_empty() {
            return Ok(None);
        }
        match self.buf[0] {
            CHANNEL_CONTROL => {
                // Scan for trailing '\n' after the channel byte.
                let Some(pos) = self.buf[1..].iter().position(|b| *b == b'\n') else {
                    return Ok(None);
                };
                let line_end = 1 + pos;
                let line = self.buf[1..line_end].to_vec();
                self.buf.drain(..=line_end);
                let msg = decode_control(&line).map_err(|e| anyhow!("decode control: {e}"))?;
                Ok(Some(Frame::Control(msg)))
            }
            CHANNEL_EVENT => {
                if self.buf.len() < 5 {
                    return Ok(None);
                }
                let len = u32::from_be_bytes(self.buf[1..5].try_into().unwrap()) as usize;
                if self.buf.len() < 5 + len {
                    return Ok(None);
                }
                let body = self.buf[5..5 + len].to_vec();
                self.buf.drain(..5 + len);
                let env: Envelope<Event> =
                    rmp_serde::from_slice(&body).map_err(|e| anyhow!("decode event: {e}"))?;
                Ok(Some(Frame::Event(env)))
            }
            other => bail!("unknown channel byte 0x{:02x}", other),
        }
    }
}

/// Unwrap the `Ok` arm of an `RpcResponse<Value>` into the concrete result
/// type `T`; bail with the `RpcError` body on the `Err` arm.
pub fn result_ok<T>(resp: RpcResponse<serde_json::Value>) -> Result<T>
where
    T: serde::de::DeserializeOwned,
{
    match resp.result {
        RpcResult::Ok { value } => serde_json::from_value(value).context("decode ok value"),
        RpcResult::Err { error } => Err(anyhow!("rpc error: {}: {}", error.code, error.message)),
    }
}

/// Unwrap the `Err` arm; bail if the server returned `Ok`.
pub fn expect_rpc_err(resp: RpcResponse<serde_json::Value>) -> Result<RpcError> {
    match resp.result {
        RpcResult::Err { error } => Ok(error),
        RpcResult::Ok { .. } => Err(anyhow!("expected Err, got Ok")),
    }
}

/// Pick a shell that's available on common macOS / Linux CI images.
pub fn pick_shell() -> &'static str {
    if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    }
}
