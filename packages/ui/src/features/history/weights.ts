/**
 * ADR 0013 ranking weights — versioned.
 *
 * The ruleset version is bumped whenever any weight or penalty changes. The
 * debug panel displays the active version next to search results so power
 * users tuning their profile can confirm which ruleset they're running.
 *
 * Changing a weight does NOT invalidate stored data; the next query simply
 * re-sorts. No migration required.
 */

export interface RankingWeights {
  readonly version: number;
  /** BM25 normalized to [0, 1] within the candidate set. */
  readonly bm25: number;
  /** Recency decay half-life applied on top of BM25. */
  readonly recency: number;
  /** Pin boost — flat additive. */
  readonly pin: number;
  /** Exact label match additive boost, per match. */
  readonly label: number;
  /** Diagnostic text match additive boost. */
  readonly diag: number;
  /** In-workspace match additive boost (active when searching globally). */
  readonly workspace: number;
  /** Per-near-duplicate prior deduction. */
  readonly dupPenalty: number;
  /** Small penalty for non-zero exit status when recency-only breaks a tie. */
  readonly failNoise: number;
  /** Half-life of the recency decay, in milliseconds. */
  readonly recencyHalfLifeMs: number;
  /** Minimum normalized BM25 at which a pinned block still floats to the top. */
  readonly pinMinBm25: number;
}

/** Default Phase 1 ruleset — mirrors the ADR text. */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  version: 1,
  bm25: 1.0,
  recency: 0.3,
  pin: 0.5,
  label: 0.2,
  diag: 0.15,
  workspace: 0.25,
  dupPenalty: 0.1,
  failNoise: 0.05,
  recencyHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
  pinMinBm25: 0.05,
};

/** Exponential decay to [0, 1]; 1.0 at now, 0.5 after one half-life. */
export function recencyDecay(timestamp: number, now: number, halfLifeMs: number): number {
  const delta = Math.max(0, now - timestamp);
  return Math.pow(0.5, delta / halfLifeMs);
}
