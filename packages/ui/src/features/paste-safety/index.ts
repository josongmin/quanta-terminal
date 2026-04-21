/**
 * Public surface for the paste-safety feature. Consumed by the composer
 * widget and the TUI input surface so a dangerous clipboard payload is
 * intercepted BEFORE it reaches the shell.
 */

export { analyze, needsConfirmation, type PasteAnalysis, type PasteRiskLevel } from './analyze.js';
export { PasteConfirmDialog, type PasteConfirmDialogProps } from './PasteConfirmDialog.js';
