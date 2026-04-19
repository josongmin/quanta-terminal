//! FIX 3 — metrics integration: session actor must feed the recorder.
//!
//! These tests assert the hot-path metrics contract for the session actor:
//!
//! 1. Every successful sink append bumps the `session.envelope.appended`
//!    counter.
//! 2. Every append (success OR fail) records an observation on the
//!    `session.append.latency_us` histogram.
//!
//! The recorder is injected via `SessionActor::spawn_with_recorder`; the
//! sink here is the no-op mock from `quanta_events::ZstdSegmentedEventLog`
//! writing to a tempdir so the actor sees real appends.

#![allow(
    clippy::doc_markdown,
    clippy::match_same_arms,
    clippy::type_complexity,
    reason = "test file uses inline ADR mentions in prose and minor pattern duplication for clarity"
)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use quanta_events::{EventSink, ZstdSegmentedEventLog};
use quanta_metrics::{InMemoryRecorder, MetricsRecorder};
use quanta_proto::events::InputKind;
use quanta_pty::{PtyError, PtyExit, PtyHandle, PtyPort, PtySize, PtySpec};
use quanta_session::{
    InputSubmission, SessionActor, SessionConfig, SessionHandle, METRIC_APPEND_LATENCY_US,
    METRIC_ENVELOPE_APPENDED,
};
use tokio::sync::{mpsc, Mutex, Notify};

#[derive(Debug)]
struct InertPty {
    read_rx: Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    closed: Arc<Notify>,
    is_closed: Arc<tokio::sync::Mutex<bool>>,
}

#[async_trait]
impl PtyHandle for InertPty {
    async fn read(&mut self, _buf: &mut [u8]) -> Result<usize, PtyError> {
        if *self.is_closed.lock().await {
            return Err(PtyError::Closed);
        }
        let mut g = self.read_rx.lock().await;
        match tokio::time::timeout(Duration::from_millis(25), g.recv()).await {
            Ok(Some(_)) => Ok(0),
            Ok(None) => Err(PtyError::Closed),
            Err(_) => Ok(0),
        }
    }
    async fn write_all(&mut self, _data: &[u8]) -> Result<(), PtyError> {
        Ok(())
    }
    async fn resize(&mut self, _size: PtySize) -> Result<(), PtyError> {
        Ok(())
    }
    async fn wait(&mut self) -> Result<PtyExit, PtyError> {
        if *self.is_closed.lock().await {
            return Ok(PtyExit::code(0));
        }
        self.closed.notified().await;
        Ok(PtyExit::code(0))
    }
    async fn kill(&mut self) -> Result<(), PtyError> {
        *self.is_closed.lock().await = true;
        self.closed.notify_waiters();
        Ok(())
    }
    fn pid(&self) -> Option<u32> {
        None
    }
}

#[derive(Debug)]
struct InertPort {
    inner: Mutex<
        Option<(
            mpsc::UnboundedReceiver<Vec<u8>>,
            Arc<Notify>,
            Arc<tokio::sync::Mutex<bool>>,
        )>,
    >,
}

impl InertPort {
    fn new() -> Self {
        let (_tx, rx) = mpsc::unbounded_channel();
        let closed = Arc::new(Notify::new());
        let is_closed = Arc::new(tokio::sync::Mutex::new(false));
        Self {
            inner: Mutex::new(Some((rx, closed, is_closed))),
        }
    }
}

#[async_trait]
impl PtyPort for InertPort {
    async fn open(&self, _spec: PtySpec) -> Result<Box<dyn PtyHandle>, PtyError> {
        let (rx, closed, is_closed) = self
            .inner
            .lock()
            .await
            .take()
            .ok_or_else(|| PtyError::Spawn("already opened".into()))?;
        Ok(Box::new(InertPty {
            read_rx: Mutex::new(rx),
            closed,
            is_closed,
        }))
    }
}

/// After `SessionCreated` + one `InputSubmitted` the recorder must see at
/// least 2 on the envelope-appended counter and at least 2 observations on
/// the latency histogram. We assert a lower bound rather than an exact value
/// because the reader task may also emit a `SessionEnded` on close.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actor_bumps_envelope_appended_counter_per_successful_append() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let sink: Arc<dyn EventSink> = log.clone();
    let port: Arc<dyn PtyPort> = Arc::new(InertPort::new());
    let recorder = InMemoryRecorder::new_arc();
    let cfg = SessionConfig::default_login("/bin/sh", PathBuf::from("/tmp"));
    let rec_trait: Arc<dyn MetricsRecorder> = recorder.clone();
    let (actor, _sid) = SessionActor::spawn_with_recorder(port, sink, cfg, rec_trait)
        .await
        .expect("spawn must succeed with live sink");

    actor
        .submit_input(InputSubmission {
            text: "hello".into(),
            kind: InputKind::Shell,
            submit: false,
        })
        .await
        .expect("submit must succeed");

    tokio::time::timeout(Duration::from_secs(5), actor.close())
        .await
        .expect("close")
        .expect("close ok");

    // SessionCreated + InputSubmitted + SessionEnded(UserClosed) ≥ 3.
    let appended = recorder.counter_value(METRIC_ENVELOPE_APPENDED);
    assert!(
        appended >= 2,
        "expected >=2 envelope.appended, got {appended}"
    );

    let snap = recorder.snapshot();
    let hist = snap
        .histograms
        .iter()
        .find(|(k, _)| k == METRIC_APPEND_LATENCY_US)
        .map(|(_, v)| v.clone())
        .expect("latency histogram must be recorded");
    assert!(
        hist.count >= 2,
        "expected >=2 latency observations, got {}",
        hist.count
    );
}
