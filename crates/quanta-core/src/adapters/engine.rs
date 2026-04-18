//! The engine binds every adapter to every port and holds the session registry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use quanta_events::{EventLogReader as _, EventSink, ZstdSegmentedEventLog};
use quanta_lifecycle::{FileMarker, RecoveryOutcome};
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::ids::{BlockId, SessionId};
use quanta_pty::{PortablePtyPort, PtyPort};
use quanta_session::{SessionActor, SessionConfig, SessionHandle};
use tokio::sync::{broadcast, Mutex};

use crate::adapters::FanoutSink;
use crate::domain::EngineConfig;

/// The engine. Holds references to the global event log and the session map.
#[derive(Clone)]
pub struct Engine {
    pub event_log: Arc<ZstdSegmentedEventLog>,
    /// Sink passed to session actors. Wraps `event_log` and broadcasts every
    /// appended envelope to subscribers (notably the socket event plane).
    pub sink: Arc<FanoutSink>,
    pub pty_port: Arc<dyn PtyPort>,
    pub sessions: Arc<Mutex<HashMap<SessionId, Arc<SessionActor>>>>,
    pub marker: FileMarker,
    pub default_shell: String,
    pub default_cwd: PathBuf,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine").finish_non_exhaustive()
    }
}

impl Engine {
    /// Boot the engine, performing crash-recovery probe and preparing adapters.
    #[expect(
        clippy::unused_async,
        reason = "async for symmetry with adapter boot paths that will grow"
    )]
    pub async fn boot(
        config: EngineConfig,
    ) -> Result<(Self, broadcast::Receiver<Envelope<Event>>)> {
        std::fs::create_dir_all(&config.profile_dir)?;
        let event_log_dir = config.profile_dir.join("events");
        let event_log = Arc::new(ZstdSegmentedEventLog::new(&event_log_dir)?);
        let marker = FileMarker::new(&config.profile_dir);
        // Probe: presence means clean previous shutdown. Missing is the default
        // state on first boot; production code would then scan the log and seal
        // live blocks as detached. Phase 1 just records the outcome.
        //
        // On probe error (fs IO issue, permissions), we deliberately fall
        // through to the conservative `RecoveredFromCrash` branch rather than
        // swallow the error as "clean". Mistakenly skipping recovery is
        // silently data-losing; running recovery on a clean session is
        // idempotent in Phase 1.
        let outcome = match marker.probe_startup() {
            Ok(o) => o,
            Err(err) => {
                tracing::warn!(
                    ?err,
                    "shutdown-marker probe failed; assuming crash-recovery"
                );
                RecoveryOutcome::RecoveredFromCrash
            }
        };
        if matches!(outcome, RecoveryOutcome::RecoveredFromCrash) {
            tracing::info!("sidecar: previous run ended without clean marker; crash-recovery path");
        }

        let (sink, rx) = FanoutSink::new(event_log.clone() as Arc<dyn EventSink>);

        Ok((
            Self {
                event_log,
                sink,
                pty_port: Arc::new(PortablePtyPort::new()),
                sessions: Arc::new(Mutex::new(HashMap::new())),
                marker,
                default_shell: std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
                default_cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            },
            rx,
        ))
    }

    /// Create a new session, wiring the PTY adapter and the event log sink.
    pub async fn create_session(
        &self,
        shell: Option<String>,
        cwd: Option<PathBuf>,
        cols: u16,
        rows: u16,
    ) -> Result<SessionId> {
        let shell = shell.unwrap_or_else(|| self.default_shell.clone());
        let cwd = cwd.unwrap_or_else(|| self.default_cwd.clone());
        let cfg = SessionConfig {
            shell,
            args: Vec::new(),
            cwd,
            cols,
            rows,
        };
        let (actor, sid) = SessionActor::spawn(
            self.pty_port.clone(),
            self.sink.clone() as Arc<dyn EventSink>,
            cfg,
        )
        .await
        .map_err(|e| anyhow!("spawn session: {e}"))?;
        self.sessions.lock().await.insert(sid, Arc::new(actor));
        Ok(sid)
    }

    pub async fn session(&self, id: SessionId) -> Option<Arc<SessionActor>> {
        self.sessions.lock().await.get(&id).cloned()
    }

    pub async fn close_session(&self, id: SessionId) -> Result<()> {
        // Remove + release the registry lock BEFORE awaiting `close()`. The
        // close path joins session tasks which can take hundreds of ms; we
        // don't want the session registry held across that window — it
        // would block unrelated create/list calls.
        let removed = self.sessions.lock().await.remove(&id);
        if let Some(s) = removed {
            if let Err(err) = s.close().await {
                // A close that errors is recoverable (the registry entry is
                // already gone), but surfacing at error level keeps on-call
                // aware: a session dying uncleanly may have leaked a task or
                // left a zombie PTY master.
                tracing::error!(session_id = %id, ?err, "close_session errored after registry removal");
                return Err(anyhow!("close session: {err}"));
            }
            tracing::info!(session_id = %id, "session closed");
        } else {
            tracing::debug!(session_id = %id, "close_session: no such session");
        }
        Ok(())
    }

    pub async fn cancel_block(&self, session: SessionId, block: BlockId) -> Result<()> {
        // Clone the Arc then drop the registry lock so block cancellation
        // doesn't serialize with unrelated session operations.
        let cloned = self.sessions.lock().await.get(&session).cloned();
        if let Some(s) = cloned {
            s.cancel_block(block)
                .await
                .map_err(|e| anyhow!("cancel block: {e}"))?;
        }
        Ok(())
    }

    pub async fn list_sessions(&self) -> Vec<SessionId> {
        self.sessions.lock().await.keys().copied().collect()
    }

    /// Replay all events for a session from the event log.
    pub async fn replay_session(
        &self,
        session: SessionId,
    ) -> Result<Vec<quanta_events::LogRecord>> {
        self.event_log
            .replay_session(session)
            .await
            .map_err(|e| anyhow!("replay: {e}"))
    }

    /// Write the clean-shutdown marker. Call on graceful shutdown.
    pub fn mark_clean_shutdown(&self) -> Result<()> {
        use quanta_lifecycle::MarkerStore as _;
        self.marker
            .write()
            .map_err(|e| anyhow!("marker write: {e}"))
    }
}
