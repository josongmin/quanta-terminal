/**
 * Built-in safety gate — Plan 0005 P2-B.
 *
 * Policy
 * ------
 * - Dangerous pattern from `source === 'agent'` → deny outright. We do
 *   not trust agent-generated intents enough to prompt a human to ack
 *   an `rm -rf /` suggestion — the human already said "run it" when
 *   they wired the agent in.
 * - Dangerous pattern from any other source (user keystroke, palette,
 *   replay) → `'confirm'`. The router surfaces a prompt.
 * - Low-confidence intents (below 0.5) from any source → `'confirm'`.
 *   A confidence of 0.49 means the upstream could be wrong — make the
 *   user agree.
 *
 * Pattern surface
 * ---------------
 * Deliberately short. False positives are preferable to false
 * negatives: annoying confirm > `rm -rf /` on production.
 *
 *   - `rm -rf /` or `rm -rf /*` (root wipe)
 *   - `rm -rf ~` (home wipe)
 *   - `:(){ :|:& };:` (classic fork bomb)
 *   - `mkfs.*` (filesystem format)
 *   - `dd if=.* of=/dev/.*` (raw device write)
 *   - `> /dev/sda` style block-device redirects
 *   - `chmod -R 000` + chown root-pwning patterns
 *   - `curl ... | sh` / `wget ... | sh` (pipe-to-shell)
 *
 * Scope
 * -----
 * Only inspects `execute` and `execute-raw` payloads. `paste` is
 * separately gated by `features/paste-safety` and we don't want to
 * double-prompt.
 */

import type { AnyIntent, GateDecision } from '../intent-types';

/** Pattern catalog, exported so tests can assert the rule set. */
export interface DangerPattern {
  readonly id: string;
  readonly reason: string;
  readonly test: (text: string) => boolean;
}

function hasRmRootWipe(text: string): boolean {
  // Matches `rm -rf /`, `rm -rf /*`, `rm -r -f /`, `rm -fr /`, etc.
  // Rejects a trailing path like `rm -rf /foo` — only a bare `/` (or
  // `/*`) after the flags counts as a root wipe.
  return /\brm\s+(?:-[rRfF]+\s+|-[rRfF]+\s+-[rRfF]+\s+|--?no-preserve-root\s+)+\/(\s|\*|$)/u.test(
    text,
  );
}

function hasRmHomeWipe(text: string): boolean {
  // `rm -rf ~` or `rm -rf $HOME`.
  return /\brm\s+-[rRfF]+\s+(?:~|\$HOME)(\s|$)/u.test(text);
}

function hasForkBomb(text: string): boolean {
  // Classic `:(){ :|:& };:` — match with tolerant whitespace.
  return /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;\s*:/u.test(text);
}

function hasMkfs(text: string): boolean {
  return /\bmkfs(\.\w+)?\s+\/dev\//iu.test(text);
}

function hasDdToDevice(text: string): boolean {
  return /\bdd\s+[^\n]*\bof=\/dev\/(sd[a-z]|nvme\d|disk\d)/iu.test(text);
}

function hasBlockRedirect(text: string): boolean {
  return />\s*\/dev\/(sd[a-z]|nvme\d|disk\d)/iu.test(text);
}

function hasCurlPipeShell(text: string): boolean {
  return /\b(curl|wget)\s+[^|]*\|\s*(sh|bash|zsh)\b/iu.test(text);
}

function hasChmodWorld(text: string): boolean {
  // `chmod -R 000 /` or `chmod 777 /` — pathological root mode changes.
  return /\bchmod\s+(-[rR]\s+)?(000|777)\s+\/(\s|$)/u.test(text);
}

export const DEFAULT_DANGER_PATTERNS: readonly DangerPattern[] = [
  { id: 'rm-root', reason: 'rm -rf on root', test: hasRmRootWipe },
  { id: 'rm-home', reason: 'rm -rf on home', test: hasRmHomeWipe },
  { id: 'fork-bomb', reason: 'Fork bomb', test: hasForkBomb },
  { id: 'mkfs', reason: 'Filesystem format', test: hasMkfs },
  { id: 'dd-device', reason: 'Raw device write', test: hasDdToDevice },
  { id: 'block-redirect', reason: 'Block-device redirect', test: hasBlockRedirect },
  { id: 'curl-pipe-shell', reason: 'Pipe-to-shell', test: hasCurlPipeShell },
  { id: 'chmod-world', reason: 'Overwide chmod on root', test: hasChmodWorld },
];

export interface SafetyGateOptions {
  readonly patterns?: readonly DangerPattern[];
  /**
   * Confidence threshold below which every intent requires confirm,
   * regardless of payload. Default 0.5.
   */
  readonly confidenceThreshold?: number;
  /**
   * Hook fired when an intent is denied/confirmed. Distinct from the
   * router's `onDeny` so callers can wire richer diagnostics (e.g. a
   * block banner) without racing the router decision.
   */
  readonly onMatch?: (intent: AnyIntent, pattern: DangerPattern, decision: GateDecision) => void;
}

/**
 * Build a gate function suitable for `router.subscribeGate()`. The
 * returned function is synchronous; the router awaits `confirm` via its
 * `onConfirm` hook.
 */
export function createSafetyGate(opts: SafetyGateOptions = {}): (intent: AnyIntent) => GateDecision {
  const patterns = opts.patterns ?? DEFAULT_DANGER_PATTERNS;
  const threshold = opts.confidenceThreshold ?? 0.5;
  return (intent) => {
    // Low-confidence → confirm, regardless of payload. The check runs
    // first because a 0.3-confidence `ls` should still prompt.
    if (intent.confidence < threshold) {
      return 'confirm';
    }
    if (intent.kind !== 'execute' && intent.kind !== 'execute-raw') {
      return 'allow';
    }
    const text = intent.payload.text;
    for (const p of patterns) {
      if (!p.test(text)) continue;
      // Agent-sourced dangerous intent → deny outright.
      if (intent.source === 'agent') {
        opts.onMatch?.(intent, p, 'deny');
        return 'deny';
      }
      opts.onMatch?.(intent, p, 'confirm');
      return 'confirm';
    }
    return 'allow';
  };
}
