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

#[cfg(feature = "sidecar")]
mod sidecar;

#[cfg(feature = "sidecar")]
mod sidecar_setup {
    //! Tauri setup glue for the sidecar boot. Split out so the borrow
    //! checker can own the slot handle without dragging `tauri::Manager`
    //! into the rest of the crate.
    use std::sync::Arc;

    pub type SidecarSlot =
        Arc<parking_lot::Mutex<Option<Arc<crate::sidecar::SidecarBridge>>>>;

    pub fn spawn_sidecar_boot<R: tauri::Runtime>(
        app: &tauri::App<R>,
        slot: SidecarSlot,
    ) {
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            // Pass the live AppHandle so the resolver can consult Tauri's
            // bundled-resource path when neither `QUANTA_CORE_BIN` nor
            // `PATH` carry the binary. Env override still wins.
            match crate::sidecar::SidecarLaunchConfig::from_env(Some(&app_handle)) {
                Ok(cfg) => match crate::sidecar::launch(cfg).await {
                    Ok(bridge) => {
                        let _ = bridge.start_event_pump(app_handle.clone());
                        *slot.lock() = Some(Arc::new(bridge));
                        tracing::info!("sidecar: quanta-core up and connected");
                    }
                    Err(err) => tracing::error!(?err, "sidecar: launch failed"),
                },
                Err(err) => tracing::error!(
                    ?err,
                    "sidecar: config error; set QUANTA_CORE_BIN, run `pnpm package-sidecar`, or install quanta-core on PATH",
                ),
            }
        });
    }
}

mod ipc;
mod shell_integration;

// Compile-time guard: the sidecar path and the embedded-shell path must not
// both be active at the same time. Either spawns a PTY, so enabling both
// would double-spawn on every `quanta_spawn_session`.
#[cfg(all(feature = "embedded-shell", feature = "sidecar"))]
compile_error!(
    "`embedded-shell` and `sidecar` are mutually exclusive. \
    Pass `--no-default-features --features sidecar` when opting into the sidecar path."
);

/// Tauri app entry. Called from `main.rs`.
pub fn run() {
    // Tracing so the shell can be diagnosed from the terminal that spawned us.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,quanta_host_tauri_lib=debug"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();

    let state = ipc::AppState::new();
    // The AppState's `sidecar` slot is an internal `Mutex` that we can reach
    // from the async setup task via a shared handle. The state itself stays
    // managed by Tauri under `State<'_, AppState>`; the handle is a clone of
    // the internal `Arc` the slot lives behind.
    #[cfg(feature = "sidecar")]
    let sidecar_slot_handle = state.sidecar_slot_arc();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            ipc::quanta_ready,
            ipc::quanta_spawn_session,
            ipc::quanta_write,
            ipc::quanta_resize,
            ipc::quanta_close,
            ipc::quanta_cancel_block,
            ipc::quanta_open_in_editor,
            ipc::quanta_ai_suggest,
            shell_integration::quanta_install_shell_integration,
        ])
        .setup(move |app| {
            tracing::info!("Quanta host (Tauri) booted; window manager attached.");
            #[cfg(feature = "sidecar")]
            sidecar_setup::spawn_sidecar_boot(app, sidecar_slot_handle.clone());
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Quanta host");
}
