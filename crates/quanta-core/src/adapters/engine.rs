//! The engine binds every adapter to every port and holds the session registry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use quanta_events::{EventLogReader as _, ZstdSegmentedEventLog};
use quanta_lifecycle::{FileMarker, RecoveryOutcome};
use quanta_proto::ids::{BlockId, SessionId};
use quanta_pty::{PortablePtyPort, PtyPort};
use quanta_session::{SessionActor, SessionConfig, SessionHandle};
use tokio::sync::Mutex;

use crate::domain::EngineConfig;

/// The engine. Holds references to the global event log and the session map.
#[derive(Clone)]
pub struct Engine {
    pub event_log: Arc<ZstdSegmentedEventLog>,
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
    pub async fn boot(config: EngineConfig) -> Result<Self> {
        std::fs::create_dir_all(&config.profile_dir)?;
        let event_log_dir = config.profile_dir.join("events");
        let event_log = Arc::new(ZstdSegmentedEventLog::new(&event_log_dir)?);
        let marker = FileMarker::new(&config.profile_dir);
        // Probe: presence means clean previous shutdown. Missing is the default
        // state on first boot; production code would then scan the log and seal
        // live blocks as detached. Phase 1 just records the outcome.
        let outcome = marker
            .probe_startup()
            .unwrap_or(RecoveryOutcome::CleanStart);
        if matches!(outcome, RecoveryOutcome::RecoveredFromCrash) {
            tracing::info!("sidecar: previous run ended without clean marker; crash-recovery path");
        }

        Ok(Self {
            event_log,
            pty_port: Arc::new(PortablePtyPort::new()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            marker,
            default_shell: std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
            default_cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
        })
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
        let (actor, sid) = SessionActor::spawn(self.pty_port.clone(), self.event_log.clone(), cfg)
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
            s.close().await.map_err(|e| anyhow!("close session: {e}"))?;
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
