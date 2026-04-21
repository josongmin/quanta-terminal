/**
 * Secret pattern registry — regex definitions for well-known credential
 * formats. Used by `detector.ts` to scan decoded command output for leaked
 * tokens, API keys, passwords, and private-key headers.
 *
 * Design constraints
 * ------------------
 * - All patterns are anchored (word boundaries / surrounding punctuation) so
 *   they don't spuriously fire on prose.
 * - No catastrophic backtracking: every quantifier has a bounded upper limit
 *   or is applied to a character class that cannot overlap with itself. We
 *   intentionally avoid `(a+)+`-style nested quantifiers to keep ReDoS out
 *   of scope.
 * - All patterns use the global flag (`g`) so the detector can walk them
 *   with `exec()` in a loop and collect every non-overlapping match.
 * - `group` lets a pattern mark ONLY its capture group as the secret body
 *   (used by the "generic assignment" form where we want to highlight just
 *   the value, not `api_key=`).
 *
 * Ordering matters: earlier entries win ties when the deduplicator in
 * `detector.ts` resolves overlapping matches. Specific prefixed kinds come
 * before the generic "assignment" fallback so a GitHub PAT is never
 * swallowed by the loose token rule.
 */

/**
 * Full taxonomy of recognised secret kinds. Exposed as a readonly array so
 * tests and UI consumers can enumerate without re-declaring the literal list.
 */
export type SecretKind =
  | 'aws-access-key'
  | 'aws-secret'
  | 'github-pat'
  | 'github-oauth'
  | 'openai-key'
  | 'slack-token'
  | 'jwt'
  | 'ssh-private-key'
  | 'generic-token';

export interface SecretPattern {
  /** Kind label propagated onto each match. */
  readonly kind: SecretKind;
  /** The regex used to scan. MUST have the `g` flag set. */
  readonly re: RegExp;
  /**
   * Optional capture-group index (1-based) whose span is the actual secret.
   * When undefined the whole match is used. Generic-token patterns set this
   * to 1 so the detector highlights just the value, not the `api_key=` key.
   */
  readonly group?: number;
  /**
   * Human-readable short label shown in UI tooltips ("AWS access key",
   * "GitHub token"). Not localized — these are well-known identifiers.
   */
  readonly label: string;
}

/**
 * Pattern registry — ordered by specificity (most specific first). The
 * detector de-duplicates overlapping matches by preferring the LONGER match
 * with ties broken by earlier start, but ordering here still matters for
 * equal-length overlaps (tie → earlier pattern wins).
 *
 * Notes on a few tricky patterns:
 *
 * - **AWS secret key** (`AWS_SECRET`): 40-char base64-ish run. This is
 *   intentionally loose because AWS never added a unique prefix. We anchor
 *   on word boundaries and drop any match that overlaps a more specific
 *   pattern via the detector's overlap resolution.
 * - **JWT**: three dot-separated base64url runs. The `eyJ` prefix is the
 *   base64 encoding of `{"` — nearly every real JWT starts with that and
 *   it lets us reject random `a.b.c` prose.
 * - **SSH private key header**: only the header line is matched. The body
 *   is multi-line and redacting it requires line-level work the caller can
 *   layer on top.
 * - **Generic token assignment**: matches `token: "…"` / `api_key=…` /
 *   `password = '…'` etc. Only the VALUE (capture group 1) is the secret
 *   so the key label stays readable in the redacted output.
 */
export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    kind: 'ssh-private-key',
    re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    label: 'SSH private key',
  },
  {
    kind: 'github-pat',
    re: /\bghp_[A-Za-z0-9]{36}\b/g,
    label: 'GitHub PAT',
  },
  {
    kind: 'github-oauth',
    re: /\b(?:gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
    label: 'GitHub OAuth token',
  },
  {
    kind: 'aws-access-key',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    label: 'AWS access key',
  },
  {
    kind: 'openai-key',
    re: /\bsk-[A-Za-z0-9]{40,60}\b/g,
    label: 'OpenAI API key',
  },
  {
    kind: 'slack-token',
    re: /\bxox[bpoas]-[0-9A-Za-z-]{10,}\b/g,
    label: 'Slack token',
  },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_./+=-]+\b/g,
    label: 'JSON Web Token',
  },
  {
    kind: 'aws-secret',
    // Loose 40-char base64-ish run. Anchored so we don't catch every base64
    // blob, but we still rely on overlap-resolution to drop false positives
    // inside a JWT / PAT (those patterns win at equal-start positions
    // because they are more specific AND longer over the overlap region).
    re: /\b[A-Za-z0-9/+]{40}\b/g,
    label: 'AWS secret key',
  },
  {
    kind: 'generic-token',
    // `token: "value"`, `api_key=value`, `password = 'value'`, etc.
    // Value (group 1) must be at least 16 characters long to avoid matching
    // noise like `password: "x"`. Character class permits URL-safe base64
    // alphabet (plus `.`) since real tokens span that space.
    re: /\b(?:token|api[_-]?key|password|secret)\s*[:=]\s*['"]?([A-Za-z0-9_\-.+/=]{16,})['"]?/gi,
    group: 1,
    label: 'Generic credential',
  },
];

/**
 * Human-readable label for a secret kind. Used by the UI when rendering the
 * redaction placeholder tooltip ("hidden GitHub PAT" etc.).
 */
export function labelForKind(kind: SecretKind): string {
  const entry = SECRET_PATTERNS.find((p) => p.kind === kind);
  return entry ? entry.label : 'secret';
}
