/**
 * Alias rewriter — Plan 0005 P2-B.
 *
 * Rewrites `execute` intents whose first shell-word matches a
 * user-registered alias. The default map ships a handful of common
 * Unix aliases (`gs` → `git status`, `gco` → `git checkout`, ...); a
 * persisted map merges on top from localStorage.
 *
 * Why only the first word
 * -----------------------
 * Aliases that rewrite a middle-of-line token (`foo gs bar`) are a
 * huge footgun: a commit message "gs" would be clobbered. Shells
 * themselves only expand aliases as the first word of a command, so we
 * mirror that.
 *
 * `execute-raw` is deliberately NOT rewritten — replay and macros
 * bypass the alias layer so they see the bytes that were originally
 * run, not whatever the user's current alias map says.
 */

import type { AnyIntent } from '../intent-types';

/** Storage key — matches `quanta:*` convention used across the repo. */
export const ALIAS_STORAGE_KEY = 'quanta:intent-aliases';

export const DEFAULT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  gs: 'git status',
  gco: 'git checkout',
  gcm: 'git commit -m',
  gp: 'git pull',
  gps: 'git push',
  gl: 'git log',
  ll: 'ls -la',
  la: 'ls -A',
  '..': 'cd ..',
  '...': 'cd ../..',
});

export interface AliasRewriterOptions {
  /** Extra aliases merged on top of the defaults + persisted map. */
  readonly aliases?: Record<string, string>;
  /**
   * Override the persistence getter (tests). When undefined the
   * rewriter reads `localStorage` at construction time.
   */
  readonly loadPersisted?: () => Record<string, string>;
  /** If true, only the `aliases` map is used — defaults are skipped. */
  readonly replaceDefaults?: boolean;
}

/** Read + parse the persisted alias blob. Tolerates malformed JSON. */
export function readPersistedAliases(
  getItem?: (key: string) => string | null,
): Record<string, string> {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return {};
  let raw: string | null;
  try {
    raw = get(ALIAS_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Persist the alias map. Best-effort — swallow storage errors. */
export function writePersistedAliases(aliases: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ALIAS_STORAGE_KEY, JSON.stringify(aliases));
  } catch {
    // Safari private-mode etc.
  }
}

/**
 * Build a rewriter function. The returned function closes over a
 * snapshot of the alias map; callers that need hot-reload should
 * re-create the rewriter after mutating storage.
 */
export function createAliasRewriter(
  opts: AliasRewriterOptions = {},
): (intent: AnyIntent) => AnyIntent | null {
  const persisted = opts.loadPersisted?.() ?? readPersistedAliases();
  const map: Record<string, string> = opts.replaceDefaults
    ? { ...(opts.aliases ?? {}) }
    : { ...DEFAULT_ALIASES, ...persisted, ...(opts.aliases ?? {}) };

  return (intent) => {
    if (intent.kind !== 'execute') return intent;
    const text = intent.payload.text;
    // Preserve leading whitespace: rare but some users pipe tab-
    // indented heredocs; rewriting eats the indentation. If the first
    // non-whitespace word is an alias, we still rewrite but keep the
    // prefix intact.
    const leadMatch = /^(\s*)(\S+)(.*)$/u.exec(text);
    if (!leadMatch) return intent;
    const [, lead, first, rest] = leadMatch as unknown as [string, string, string, string];
    const replacement = map[first];
    if (replacement === undefined) return intent;
    const rewritten = `${lead}${replacement}${rest}`;
    return {
      ...intent,
      payload: { text: rewritten },
    };
  };
}
