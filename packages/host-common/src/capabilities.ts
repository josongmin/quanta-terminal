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
}

export const DEFAULT_CAPABILITIES: HostCapabilities = {
  nativeWindowChrome: false,
  systemNotifications: false,
  editorIntegration: false,
  windowsShellParity: false,
  embeddedDevShell: false,
};
