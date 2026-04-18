//! `quanta-core` binary entry point.
//!
//! Parses minimal CLI flags and starts the engine. For Phase 1 we do not start
//! a Unix-socket server by default unless `--socket` is provided — the
//! walking-skeleton acceptance test drives the engine library directly.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use quanta_core::{ControlRegistry, Engine, EngineConfig};
use quanta_protocol::UnixSocketServer;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = parse_args();
    let engine = Engine::boot(EngineConfig {
        socket_path: args.socket_path.clone(),
        profile_dir: args.profile_dir.clone(),
    })
    .await
    .context("boot engine")?;

    if let Some(socket_path) = args.socket_path {
        let handler = ControlRegistry::new(engine.clone());
        let server = UnixSocketServer::new(socket_path, handler as Arc<_>);
        server.serve().await.context("serve")?;
    } else {
        tracing::info!("no --socket provided; engine idle. (Pass --socket <path> to serve.)");
        // Wait forever so the binary stays up for inspection.
        let _ = tokio::signal::ctrl_c().await;
    }

    // Clean shutdown marker.
    let _ = engine.mark_clean_shutdown();
    Ok(())
}

struct CliArgs {
    socket_path: Option<PathBuf>,
    profile_dir: PathBuf,
}

fn parse_args() -> CliArgs {
    let mut socket_path: Option<PathBuf> = None;
    let mut profile_dir: PathBuf = dirs_profile_default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => {
                if let Some(v) = args.next() {
                    socket_path = Some(PathBuf::from(v));
                }
            }
            "--profile" => {
                if let Some(v) = args.next() {
                    profile_dir = PathBuf::from(v);
                }
            }
            "-h" | "--help" => {
                eprintln!("quanta-core --socket <path> --profile <dir>");
                std::process::exit(0);
            }
            other => {
                eprintln!("quanta-core: unknown flag: {other}");
                std::process::exit(2);
            }
        }
    }
    CliArgs {
        socket_path,
        profile_dir,
    }
}

fn dirs_profile_default() -> PathBuf {
    if let Ok(h) = std::env::var("HOME") {
        PathBuf::from(h).join(".local/share/quanta")
    } else {
        PathBuf::from("./quanta-profile")
    }
}
