/**
 * Tokenization + BM25 scoring helpers.
 *
 * Tokenization is intentionally simple: lowercase, split on non-alphanumerics,
 * drop empties. That matches what Warp's command history index does and is
 * enough for Phase-4 UX; smarter analyzers (stemming, n-grams) land when the
 * sidecar-driven FTS5 index takes over.
 *
 * BM25 implementation is the standard Okapi formula with `k1=1.5`, `b=0.75`
 * and single-term IDF:
 *
 *     idf(q)      = ln((N - df + 0.5) / (df + 0.5) + 1)
 *     score(d, q) = sum over q_i of
 *                   idf(q_i) * tf_i * (k1 + 1) / (tf_i + k1 * (1 - b + b * |d| / avg_dl))
 *
 * The whole corpus fits in memory (2000 blocks, tens of KB of text per block
 * after truncation) so we build a fresh index on every search call. An index
 * cache lives one level up in `search.ts`.
 */

const TOKEN_RE = /[a-z0-9]+/gu;

export function tokenize(text: string): string[] {
  if (!text) return [];
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

export interface Document {
  readonly id: string;
  readonly tokens: readonly string[];
}

export interface Bm25Index {
  readonly docs: readonly Document[];
  readonly docFreq: ReadonlyMap<string, number>;
  readonly avgLen: number;
  readonly size: number;
}

export function buildIndex(docs: readonly Document[]): Bm25Index {
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.tokens.length;
    const seen = new Set<string>();
    for (const t of d.tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
  }
  return {
    docs,
    docFreq,
    avgLen: docs.length > 0 ? totalLen / docs.length : 0,
    size: docs.length,
  };
}

export interface Bm25Score {
  readonly score: number;
  readonly matchedTokens: readonly string[];
}

/** Score a single document against query tokens. k1=1.5, b=0.75 per standard
 *  BM25 defaults. Returns the raw (unnormalized) score and the subset of
 *  query tokens that appeared in the document. */
export function bm25Score(
  doc: Document,
  queryTokens: readonly string[],
  index: Bm25Index,
  opts?: { readonly k1?: number; readonly b?: number },
): Bm25Score {
  const k1 = opts?.k1 ?? 1.5;
  const b = opts?.b ?? 0.75;
  const dl = doc.tokens.length;
  if (dl === 0 || queryTokens.length === 0) {
    return { score: 0, matchedTokens: [] };
  }
  const tf = new Map<string, number>();
  for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  const matched: string[] = [];
  for (const q of queryTokens) {
    const f = tf.get(q);
    if (!f) continue;
    matched.push(q);
    const df = index.docFreq.get(q) ?? 0;
    // Okapi BM25 idf with +1 floor so rare terms don't swing negative.
    const idf = Math.log((index.size - df + 0.5) / (df + 0.5) + 1);
    const denom = f + k1 * (1 - b + (b * dl) / (index.avgLen || 1));
    score += idf * ((f * (k1 + 1)) / denom);
  }
  return { score, matchedTokens: matched };
}

/** Normalize a collection of raw BM25 scores to [0, 1]. Safe on empty arrays
 *  and when the max is zero (returns zeros). */
export function normalizeScores(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  let max = 0;
  for (const s of scores) if (s > max) max = s;
  if (max === 0) return scores.map(() => 0);
  return scores.map((s) => s / max);
}
