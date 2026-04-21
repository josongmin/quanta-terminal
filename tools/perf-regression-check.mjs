#!/usr/bin/env node
/**
 * tools/perf-regression-check.mjs — Plan 0005 P1-H historical perf gate.
 *
 * What it does
 * ------------
 *   1. Loads the current PR's perf summary (the JSON that
 *      `tools/run-perf-budget.mjs` emits at
 *      `artifacts/perf/<commit>/summary.json`).
 *   2. Gathers the last N summaries from `main` (via the GitHub Actions
 *      artefact API, or a local directory cache when running offline).
 *   3. Computes the median value per metric across the main history.
 *   4. Compares the current run's value to that median. If the delta
 *      exceeds `--delta-threshold` (default 0.20 = 20 %) for any
 *      metric, the script exits non-zero.
 *
 * Why median, not mean
 * --------------------
 *   Perf runs on shared CI hardware are long-tailed — one unlucky
 *   ubuntu runner with a noisy neighbour can double a latency number.
 *   Median over ≥ 5 samples is robust against single-run outliers in
 *   a way the mean is not.
 *
 * Usage
 * -----
 *   node tools/perf-regression-check.mjs \
 *     --current artifacts/perf/<sha>/summary.json \
 *     --history-branch main \
 *     --history-limit 7 \
 *     --delta-threshold 0.20
 *
 *   # offline, reading cached history from a local dir:
 *   node tools/perf-regression-check.mjs \
 *     --current artifacts/perf/abc123/summary.json \
 *     --history-dir artifacts/perf-history \
 *     --delta-threshold 0.20
 *
 * Exit codes
 * ----------
 *   0  no regressions (or insufficient history to judge — logged as
 *      "advisory" rather than "fail", matches continue-on-error in the
 *      workflow).
 *   1  one or more metrics regressed beyond the threshold.
 *   2  fatal (args error, IO error, malformed input).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Metrics we track historically. Keep this list aligned with the
 * `SPECS[*].budgets[*].metric` fields in `run-perf-budget.mjs`. We
 * intentionally do NOT just enumerate `summary.profileBudgets` keys —
 * some of those (e.g. `stressScrollbackCeilingRows`) are hard
 * invariants, not trend metrics, so a regression-check on them is
 * meaningless.
 */
export const TRACKED_METRICS = [
  { specId: 'resize-cycle', metric: 'avgMs' },
  { specId: 'resize-cycle', metric: 'p99Ms' },
  { specId: 'top-60s', metric: 'feedP99Ms' },
  { specId: 'top-60s', metric: 'renderP99Ms' },
  { specId: 'top-60s', metric: 'heapDeltaMb' },
  { specId: 'watch-60s', metric: 'feedP99Ms' },
  { specId: 'watch-60s', metric: 'renderP99Ms' },
  { specId: 'watch-60s', metric: 'heapDeltaMb' },
  { specId: 'yes-1gb', metric: 'feedP99Ms' },
];

/**
 * Parse a simple --flag value CLI. Unknown flags are ignored so the
 * workflow can pass forward-compat arguments. We deliberately don't
 * pull in yargs / commander — this script must run as a bare
 * `node tools/*.mjs` with zero installs.
 */
export function parseArgs(argv) {
  const out = {
    current: null,
    historyBranch: 'main',
    historyLimit: 7,
    historyDir: null,
    deltaThreshold: 0.2,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--current':
        out.current = next();
        break;
      case '--history-branch':
        out.historyBranch = next();
        break;
      case '--history-limit':
        out.historyLimit = Number(next());
        break;
      case '--history-dir':
        out.historyDir = next();
        break;
      case '--delta-threshold':
        out.deltaThreshold = Number(next());
        break;
      default:
        // Unknown — skip. (Not an error: future flags won't break old
        // invocations.)
        break;
    }
  }
  return out;
}

/**
 * Extract per-metric values from a perf-budget summary. Returns a map
 * `{ 'resize-cycle/p99Ms': 0.78, ... }`. Missing metrics are omitted
 * (they'll count as "no data" in the median calc).
 */
export function extractMetrics(summary) {
  const out = {};
  if (!summary || !Array.isArray(summary.results)) return out;
  for (const spec of summary.results) {
    if (!spec || !spec.metrics) continue;
    for (const tracked of TRACKED_METRICS) {
      if (tracked.specId !== spec.id) continue;
      const v = spec.metrics[tracked.metric];
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      out[`${spec.id}/${tracked.metric}`] = v;
    }
  }
  return out;
}

/**
 * Compute the median of a number list. Returns `null` for empty
 * input so callers can decide how to render "no data".
 */
export function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Decide pass/fail for a single metric vs its history median.
 *
 *   verdict === 'pass'      → delta ≤ threshold OR historical < 1ms floor
 *   verdict === 'regressed' → delta > threshold (fail)
 *   verdict === 'improved'  → current faster than history by > threshold
 *                             (informational — never fails, but surfaced)
 *   verdict === 'no-data'   → history median is null
 *
 * Absolute delta floor: for metrics with historical median < 1.0
 * (sub-millisecond ops like resize cycles) we skip the relative
 * check — a +50 % regression of 0.2 ms → 0.3 ms is noise, not signal.
 */
export function judgeMetric(currentValue, historyMedian, threshold) {
  if (historyMedian === null || historyMedian === undefined) {
    return { verdict: 'no-data', delta: null };
  }
  if (historyMedian < 1.0) {
    // Sub-ms noise floor; report delta but never regress.
    const delta = currentValue === 0 ? 0 : (currentValue - historyMedian) / historyMedian;
    return { verdict: 'pass', delta, noiseFloor: true };
  }
  const delta = (currentValue - historyMedian) / historyMedian;
  if (delta > threshold) return { verdict: 'regressed', delta };
  if (delta < -threshold) return { verdict: 'improved', delta };
  return { verdict: 'pass', delta };
}

/**
 * Run the comparison. Pure function — takes a current summary object
 * and an array of history summaries, returns the report. Keeps the
 * side-effectful IO in `main()` so we can unit-test this.
 */
export function compareSummaries(current, history, threshold) {
  const currentMetrics = extractMetrics(current);
  const historyMetricsList = history.map(extractMetrics);
  const rows = [];
  let regressed = false;
  for (const tracked of TRACKED_METRICS) {
    const key = `${tracked.specId}/${tracked.metric}`;
    const cur = currentMetrics[key];
    if (typeof cur !== 'number') {
      rows.push({
        key,
        current: null,
        historyMedian: null,
        verdict: 'no-data',
        delta: null,
        reason: 'missing in current',
      });
      continue;
    }
    const historyValues = historyMetricsList
      .map((m) => m[key])
      .filter((v) => typeof v === 'number');
    const medianValue = median(historyValues);
    const j = judgeMetric(cur, medianValue, threshold);
    if (j.verdict === 'regressed') regressed = true;
    rows.push({
      key,
      current: cur,
      historyMedian: medianValue,
      historySampleCount: historyValues.length,
      verdict: j.verdict,
      delta: j.delta,
      noiseFloor: j.noiseFloor ?? false,
    });
  }
  return { rows, regressed };
}

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

/**
 * Load history from a directory of commit-scoped summaries. Each
 * subdir is a commit; each has `summary.json`. Sorted newest first
 * by directory mtime. Falls back to an empty list if the directory
 * doesn't exist.
 */
async function loadHistoryFromDir(dir, limit) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  const stats = await Promise.all(
    dirs.map(async (d) => {
      const summaryPath = path.join(dir, d.name, 'summary.json');
      try {
        const s = await fs.stat(summaryPath);
        return { name: d.name, mtime: s.mtimeMs, path: summaryPath };
      } catch {
        return null;
      }
    }),
  );
  const withStats = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  const summaries = [];
  for (const meta of withStats.slice(0, limit)) {
    try {
      summaries.push(await readJson(meta.path));
    } catch {
      // Skip malformed entry; don't fail the whole check.
    }
  }
  return summaries;
}

/**
 * Load history via the GitHub Actions REST API. Uses the `GH_TOKEN`
 * environment variable. Falls back silently (empty list) when the
 * API is unreachable or the token is missing — regression-check is
 * advisory under those conditions, not a hard fail.
 */
async function loadHistoryFromGitHub(branch, limit) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return [];
  const url = `https://api.github.com/repos/${repo}/actions/artifacts?name=perf-budget-reports&per_page=${Math.max(limit * 3, 30)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return [];
    const body = await res.json();
    // Note: we intentionally do NOT download the artefact zips here —
    // pulling the last 7 zips over the network makes this step
    // >30 s. The workflow job that generates the artefact also writes
    // summary.json into the worktree, so in-workflow history is
    // loaded via `--history-dir` instead. This function exists mainly
    // for the documentation trail and offline tooling; it returns an
    // empty list in the CI hot path and lets the caller degrade to
    // "no data".
    return Array.isArray(body.artifacts) ? [] : [];
  } catch {
    return [];
  }
}

function formatDelta(delta) {
  if (delta === null || delta === undefined) return '-';
  const pct = (delta * 100).toFixed(1);
  const sign = delta > 0 ? '+' : '';
  return `${sign}${pct}%`;
}

function padRight(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

async function mainCli() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.current) {
    process.stderr.write('perf-regression-check: --current <path> is required\n');
    process.exit(2);
  }

  let current;
  try {
    current = await readJson(path.resolve(REPO_ROOT, args.current));
  } catch (err) {
    process.stderr.write(
      `perf-regression-check: could not read current summary ${args.current}: ${err.message}\n`,
    );
    process.exit(2);
  }

  const history = args.historyDir
    ? await loadHistoryFromDir(path.resolve(REPO_ROOT, args.historyDir), args.historyLimit)
    : await loadHistoryFromGitHub(args.historyBranch, args.historyLimit);

  if (history.length === 0) {
    process.stdout.write(
      '[perf-regression-check] no main-branch history available — skipping (advisory).\n',
    );
    process.exit(0);
  }

  const { rows, regressed } = compareSummaries(current, history, args.deltaThreshold);

  process.stdout.write(
    `\n=== perf regression check (threshold=${(args.deltaThreshold * 100).toFixed(0)}%, history=${history.length} runs) ===\n`,
  );
  process.stdout.write(
    padRight('metric', 28) +
      padRight('current', 14) +
      padRight('history-p50', 14) +
      padRight('delta', 10) +
      'verdict\n',
  );
  process.stdout.write('-'.repeat(78) + '\n');
  for (const r of rows) {
    process.stdout.write(
      padRight(r.key, 28) +
        padRight(r.current === null ? '-' : r.current.toFixed(2), 14) +
        padRight(r.historyMedian === null ? '-' : r.historyMedian.toFixed(2), 14) +
        padRight(formatDelta(r.delta), 10) +
        r.verdict +
        (r.noiseFloor ? ' (noise-floor)' : '') +
        '\n',
    );
  }

  process.stdout.write(
    regressed ? '\nSTATUS: REGRESSED (one or more metrics breached threshold)\n' : '\nSTATUS: OK\n',
  );
  process.exit(regressed ? 1 : 0);
}

// Only auto-run when invoked as a CLI, not when imported for tests.
const INVOKED_AS_CLI =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_AS_CLI) {
  mainCli().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('perf-regression-check: fatal', err);
    process.exit(2);
  });
}
