/**
 * Shell-integration wizard — detection logic.
 *
 * Maps the session entity's `shellIntegration` status into a wizard UX state:
 * whether the wizard should be offered at all, which shell the host looks
 * like, and what banner step the wizard should paint first.
 *
 * This module does NOT subscribe to the store — the widget reads the current
 * session via selectors and passes the input to a pure function. That keeps
 * the feature trivially testable and keeps the FSD seam clean (no side
 * effects at module scope).
 *
 * See ADR 0002 §Degraded Mode for the contract.
 */

import type { ShellKind } from '@quanta/host-common';
import type { ShellIntegrationStatus } from '../../shared/types/generated/index.js';

/**
 * Three UX steps the wizard can be in:
 *   - `detect`  — we opened the wizard; we need to decide whether action is
 *                 required. If the status is `installed`, we display a
 *                 "you're good" confirmation screen.
 *   - `preview` — we have fetched the snippet and are showing it to the user.
 *   - `confirm` — the user clicked "Install" and we are showing success or
 *                 failure feedback.
 */
export type WizardStep = 'detect' | 'preview' | 'confirm';

/**
 * The result of the initial detection pass. `needsInstall` is the top-level
 * gating signal; `shell` is a best-effort classification of the running shell
 * path (falls back to `bash` when the shell is unknown, consistent with
 * POSIX defaults).
 */
export interface DetectionResult {
  /** True iff the session is missing or only partially integrated. */
  readonly needsInstall: boolean;
  /** The normalized shell kind we will try to install into. */
  readonly shell: ShellKind;
  /** The raw shell string reported by the session (for diagnostics). */
  readonly rawShell: string;
  /** The recommended starting step for the wizard. */
  readonly initialStep: WizardStep;
}

/** Inputs the detector needs — kept minimal to avoid the store dep. */
export interface DetectionInput {
  readonly shellIntegration: ShellIntegrationStatus;
  /** The session's `shell` field (e.g. `/bin/zsh`, `/usr/local/bin/fish`). */
  readonly shell: string;
}

/**
 * Classify a shell binary path into one of the three kinds we can install
 * integration for. Matches the basename against known suffixes; falls back
 * to `bash` because POSIX shells behave close enough to bash that the bash
 * script is a safer default than nothing.
 */
export function classifyShell(shellPath: string): ShellKind {
  const base = shellPath.split('/').pop() ?? '';
  const lc = base.toLowerCase();
  if (lc === 'zsh' || lc.endsWith('zsh')) return 'zsh';
  if (lc === 'fish' || lc.endsWith('fish')) return 'fish';
  // Treat `bash`, `sh`, `dash`, and unknowns as bash-compatible.
  return 'bash';
}

/**
 * Pure detector — no side effects, deterministic. Returns the initial UX
 * state the wizard should render.
 */
export function detect(input: DetectionInput): DetectionResult {
  const shell = classifyShell(input.shell);
  const needsInstall = input.shellIntegration !== 'installed';
  return {
    needsInstall,
    shell,
    rawShell: input.shell,
    // When the integration is already installed we still start on `detect` so
    // the user sees a confirmation message; the wizard then auto-closes or
    // surfaces a "re-install" affordance.
    initialStep: 'detect',
  };
}
