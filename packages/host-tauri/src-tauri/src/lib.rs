//! Quanta Terminal — Tauri host crate.
//!
//! Exposes an IPC façade (`quanta_*` commands + `quanta://*` events) that the
//! TypeScript `TauriHostBridge` speaks. The IPC shape is deliberately a
//! subset of what the real `quanta-core` sidecar will offer, so swapping the
//! embedded dev shell for the sidecar (ADR 0004) only touches this file.
//!
//! Phase 1: compiled with `default = ["embedded-shell"]`, which provides a
//! `portable-pty`-based shell implementation used for the walking skeleton
//! before the real engine ships. The stub is clearly marked for removal.

#[cfg(feature = "embedded-shell")]
mod embedded_shell;

mod ipc;

/// Tauri app entry. Called from `main.rs`.
pub fn run() {
    // Tracing so the shell can be diagnosed from the terminal that spawned us.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,quanta_host_tauri_lib=debug"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();

    let state = ipc::AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            ipc::quanta_ready,
            ipc::quanta_spawn_session,
            ipc::quanta_write,
            ipc::quanta_resize,
            ipc::quanta_close,
        ])
        .setup(|app| {
            tracing::info!("Quanta host (Tauri) booted; window manager attached.");
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Quanta host");
}
