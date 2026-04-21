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
 *   - `rm -rf ~` / `rm -rf $HOME` / `rm -rf $HOME/*` (home wipe)
 *   - `rm -rf /{etc,usr,var,boot,bin,sbin,lib,sys,proc}` (system-dir wipe)
 *   - `:(){ :|:& };:` (classic fork bomb)
 *   - `mkfs.*` on `/dev/*` (filesystem format)
 *   - `dd if=.* of=/dev/.*` (raw device write)
 *   - `> /dev/sd*`, `> /dev/mem`, `> /proc/*` (device / kernel redirects)
 *   - `chmod -R 000|777 /` (root-pwning mode changes)
 *   - `curl ... | sh` / `wget ... | sh` (pipe-to-shell)
 *   - Any of the above prefixed with `sudo ` / `doas ` — the root
 *     escalation is what makes an otherwise-merely-dangerous command
 *     unrecoverable, so it's re-scanned independently.
 *
 * Shell-string awareness
 * ----------------------
 * Commands wrapped in a visible pair of single or double quotes
 * (`echo "rm -rf /"`) are NOT flagged — the quote is a best-effort
 * signal that the dangerous text is a string literal, not an argv
 * entry. We do NOT try to parse the full shell grammar; heredocs,
 * escaped quotes, and nested quoting can still slip through, so
 * upstream callers must not rely on this as a complete sandbox.
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
  // `rm -rf ~`, `rm -rf $HOME`, `rm -rf $HOME/*`, `rm -rf ~/` variants.
  return /\brm\s+-[rRfF]+\s+(?:~|\$HOME)(\/\*?|\s|$)/u.test(text);
}

/** System-critical directories whose wipe is effectively unrecoverable. */
const SYSTEM_DIR_WIPE =
  /\brm\s+(?:-[rRfF]+\s+|--?no-preserve-root\s+)+\/(?:etc|usr|var|boot|bin|sbin|lib|lib64|sys|proc|root)(\/\*?|\s|$)/u;

function hasSystemDirWipe(text: string): boolean {
  return SYSTEM_DIR_WIPE.test(text);
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
  // Device nodes, memory, and kernel pseudo-fs writes.
  return />\s*\/(dev\/(sd[a-z]|nvme\d|disk\d|mem|kmem|port)|proc\/sysrq-trigger|sys\/)/iu.test(
    text,
  );
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
  { id: 'rm-system-dir', reason: 'rm -rf on system directory', test: hasSystemDirWipe },
  { id: 'fork-bomb', reason: 'Fork bomb', test: hasForkBomb },
  { id: 'mkfs', reason: 'Filesystem format', test: hasMkfs },
  { id: 'dd-device', reason: 'Raw device write', test: hasDdToDevice },
  { id: 'block-redirect', reason: 'Block / kernel-fs redirect', test: hasBlockRedirect },
  { id: 'curl-pipe-shell', reason: 'Pipe-to-shell', test: hasCurlPipeShell },
  { id: 'chmod-world', reason: 'Overwide chmod on root', test: hasChmodWorld },
];

/**
 * Best-effort shell-string stripper. Removes visible `"..."` and `'...'`
 * runs so a `echo "rm -rf /"` no longer trips the pattern scan. Heredocs,
 * escaped quotes, and nested quoting are out of scope; this is a
 * convenience layer, not a shell parser.
 */
function stripShellStrings(text: string): string {
  // Double-quoted: may contain escaped characters like \" — keep it
  // conservative and only drop balanced visible pairs.
  let out = text.replace(/"(?:\\.|[^"\\])*"/gu, '""');
  out = out.replace(/'[^']*'/gu, "''");
  return out;
}

/**
 * Re-scan the inner command of a `sudo` / `doas` prefix. Without this,
 * `sudo rm -rf /` would still trip `hasRmRootWipe` (because the regex
 * uses `\brm`), but a pattern like `sudo chmod 777 /etc` is caught by
 * `hasSystemDirWipe`. The re-scan ensures the *escalated* form matches
 * the same rules as the unescalated form (ex: a future pattern that
 * matches only bare commands still fires with `sudo` in front).
 */
function stripPrivilegeEscalation(text: string): string {
  return text.replace(/^\s*(?:sudo|doas)(?:\s+-[A-Za-z]+)*\s+/u, '');
}

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
  /**
   * Disable shell-string stripping. Default `false` — strings are
   * stripped so `echo "rm -rf /"` does NOT match `rm-root`. Flip this
   * to `true` for paranoid scanning that flags every visible byte
   * (e.g. AI-proposed commands where we don't trust the quoting).
   */
  readonly paranoid?: boolean;
}

/** Exposed for tests; not part of the public runtime surface. */
export const __testing = {
  stripShellStrings,
  stripPrivilegeEscalation,
} as const;

/**
 * Build a gate function suitable for `router.subscribeGate()`. The
 * returned function is synchronous; the router awaits `confirm` via its
 * `onConfirm` hook.
 */
export function createSafetyGate(opts: SafetyGateOptions = {}): (intent: AnyIntent) => GateDecision {
  const patterns = opts.patterns ?? DEFAULT_DANGER_PATTERNS;
  const threshold = opts.confidenceThreshold ?? 0.5;
  const paranoid = opts.paranoid ?? false;
  return (intent) => {
    // Low-confidence → confirm, regardless of payload. The check runs
    // first because a 0.3-confidence `ls` should still prompt.
    if (intent.confidence < threshold) {
      return 'confirm';
    }
    if (intent.kind !== 'execute' && intent.kind !== 'execute-raw') {
      return 'allow';
    }
    const raw = intent.payload.text;
    // Scan two normalised views of the payload:
    //   1. The raw text — catches `rm -rf /` inside `$(...)` or `;`.
    //   2. The escalation-stripped + string-stripped text — catches
    //      `sudo rm -rf /` while ignoring `echo "rm -rf /"`.
    const escalationStripped = stripPrivilegeEscalation(raw);
    const scanned = paranoid
      ? [raw, escalationStripped]
      : [stripShellStrings(raw), stripShellStrings(escalationStripped)];
    for (const p of patterns) {
      const hit = scanned.some((t) => p.test(t));
      if (!hit) continue;
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
