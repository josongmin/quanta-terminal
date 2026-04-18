/**
 * Banner precedence — ADR 0010 §"Banner Triggers".
 *
 * Only one banner is visible at a time. When multiple conditions fire, the
 * higher-precedence banner wins; the others queue silently. Dismissal is
 * per-session and per-condition (see banner's own props).
 *
 * Order (highest first):
 *   crash > quota > secret_rescan > shell_integration
 */

export type BannerCondition = 'crash' | 'quota' | 'secret_rescan' | 'shell_integration';

const PRECEDENCE: Readonly<Record<BannerCondition, number>> = {
  crash: 3,
  quota: 2,
  secret_rescan: 1,
  shell_integration: 0,
};

/**
 * Pick the highest-precedence condition from a set of currently-active ones.
 * Returns `undefined` when the set is empty.
 */
export function pickBannerCondition(
  active: Iterable<BannerCondition>,
): BannerCondition | undefined {
  let best: BannerCondition | undefined;
  let bestRank = -1;
  for (const c of active) {
    const rank = PRECEDENCE[c];
    if (rank > bestRank) {
      best = c;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Compare two conditions. Positive when `a` outranks `b`.
 * Exposed for deterministic queue ordering when the condition set grows.
 */
export function compareBannerCondition(a: BannerCondition, b: BannerCondition): number {
  return PRECEDENCE[a] - PRECEDENCE[b];
}
