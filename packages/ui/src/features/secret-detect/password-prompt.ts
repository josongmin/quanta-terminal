/**
 * Password-prompt detection — pattern matching over recent output bytes so
 * the composer can flip into "password mode" the moment sudo/ssh/git/etc.
 * asks for credentials.
 *
 * Why pattern-based
 * -----------------
 * A real TTY would toggle `ECHO` off on the line-discipline and we could
 * observe that via termios — but we always run the PTY with `-echo` to
 * avoid double-echo. The termios channel is therefore useless to us and we
 * fall back to text heuristics. The patterns below are deliberately narrow
 * so we stay conservative: false positives mean the composer briefly masks
 * benign input (annoying) whereas false negatives mean the user's password
 * ends up in output+history (unacceptable). We tilt toward false positive.
 *
 * The detector is scoped: callers (BlockBody) pass the LAST few lines of
 * already-rendered output and we match against just that window so old
 * output never re-triggers. Empty / whitespace-only input returns `null`.
 */

/**
 * Ordered list of prompt patterns we recognise. Kept in priority order so
 * the more specific `[sudo] password for X` beats the generic `password:`.
 * Each regex MUST match a trailing colon or whitespace so a mid-line token
 * like "my_password_hash =" doesn't false-positive.
 */
const PASSWORD_PROMPT_PATTERNS: ReadonlyArray<{
  readonly kind: string;
  readonly pattern: RegExp;
}> = [
  { kind: 'sudo', pattern: /\[sudo\]\s+password\s+for\s+\w+/i },
  { kind: 'ssh-passphrase', pattern: /enter\s+passphrase\s+for/i },
  { kind: 'passphrase', pattern: /passphrase[:\s]/i },
  { kind: 'your-password', pattern: /\byour\s+password\b/i },
  { kind: 'enter-password', pattern: /enter\s+password/i },
  // Generic fallback: "Password:" at the end of a line, possibly with
  // trailing whitespace. Anchoring to end-of-line keeps us conservative
  // on things like "password rules" inside normal prose output.
  { kind: 'password', pattern: /(^|[\s(])password\s*:\s*$/im },
];

export interface PasswordPromptMatch {
  readonly kind: string;
  readonly matched: string;
}

/**
 * Scan a chunk of rendered output text for a password-prompt signature.
 * Returns the first match (in pattern-priority order) or `null`. The
 * caller is responsible for trimming the input to a bounded window — we do
 * not slice internally because the "last N lines" policy differs per
 * caller (BlockBody uses tail bytes; the composer may pass a single line).
 */
export function detectPasswordPrompt(text: string): PasswordPromptMatch | null {
  if (text.length === 0) return null;
  for (const entry of PASSWORD_PROMPT_PATTERNS) {
    const m = entry.pattern.exec(text);
    if (m) {
      return { kind: entry.kind, matched: m[0] };
    }
  }
  return null;
}

/**
 * Convenience for consumers that feed a byte-oriented tail buffer — grabs
 * the last `n` lines (default 4) so a stale match in the middle of the
 * block doesn't re-trigger the composer mode switch.
 */
export function tailLines(text: string, n = 4): string {
  if (text.length === 0 || n <= 0) return '';
  // Walk backwards counting newlines. This is O(text length) but tail
  // buffers are bounded by the caller so the work is negligible.
  let seen = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      seen += 1;
      if (seen > n) return text.slice(i + 1);
    }
  }
  return text;
}

/**
 * Explicit list of prompt "kinds" we recognise. Exposed so UI layers can
 * render a localized label (e.g. "Sudo password") without string-matching
 * against the internal regex id.
 */
export const PASSWORD_PROMPT_KINDS = PASSWORD_PROMPT_PATTERNS.map((p) => p.kind);
