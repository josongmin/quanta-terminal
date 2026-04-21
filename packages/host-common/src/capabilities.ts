/**
 * HostCapabilities — boolean flags the UI reads to enable or hide features
 * that only make sense on one host (per ADR 0001).
 *
 * Capabilities are declarative, not imperative: the UI checks them and
 * conditionally renders. It never string-matches on a host name.
 */

export interface HostCapabilities {
  /** The host controls its own window chrome (traffic lights, drag region). */
  readonly nativeWindowChrome: boolean;
  /** The host can post OS-level notifications. */
  readonly systemNotifications: boolean;
  /** The host exposes an `EditorBridge` that actually navigates files. */
  readonly editorIntegration: boolean;
  /** Windows-ish path separators / env. Defaults false; no Phase-1 Windows support. */
  readonly windowsShellParity: boolean;
  /** Host is running the Phase-1 embedded dev shell rather than the real core. */
  readonly embeddedDevShell: boolean;
  /**
   * Host is running on the Linux kernel shim that Windows Subsystem for
   * Linux (WSL 1 / 2) provides. Detected via `/proc/version` containing
   * "Microsoft" or "WSL" — see `quanta_host_tauri_lib::embedded_shell::is_wsl`.
   *
   * UI consumers can use this flag to surface a one-shot hint ("WSL detected —
   * Windows drives live under /mnt/...") or to pick a Linux-shaped default
   * keybinding hint without probing `navigator.platform` (which reports
   * Linux-like strings inside the WSLg webview and is therefore ambiguous).
   */
  readonly wslEnvironment: boolean;
}

export const DEFAULT_CAPABILITIES: HostCapabilities = {
  nativeWindowChrome: false,
  systemNotifications: false,
  editorIntegration: false,
  windowsShellParity: false,
  embeddedDevShell: false,
  wslEnvironment: false,
};
