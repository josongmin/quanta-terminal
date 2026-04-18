/**
 * Event entity — runtime model of HostEvent for the UI.
 *
 * The xterm surface consumes pty.data events directly via a subscription;
 * higher-level widgets (status bar, future block list) will subscribe here.
 * Phase 1 keeps this thin.
 */

export type { HostEvent, HostEventKind } from '@quanta/host-common';
export { isEventOfKind } from '@quanta/host-common';
