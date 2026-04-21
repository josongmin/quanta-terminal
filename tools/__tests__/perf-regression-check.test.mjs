#!/usr/bin/env node
/**
 * Tests for `tools/perf-regression-check.mjs`.
 *
 * Focuses on the pure comparison core (`extractMetrics`, `median`,
 * `judgeMetric`, `compareSummaries`) — no IO, no network. The CLI
 * wrapper is out of scope here; `tools/check-perf-ready.mjs` covers
 * the wiring.
 *
 * Run directly: `node --test tools/__tests__/perf-regression-check.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRACKED_METRICS,
  DEFAULT_PER_METRIC_THRESHOLDS,
  parseArgs,
  extractMetrics,
  median,
  judgeMetric,
  compareSummaries,
} from '../perf-regression-check.mjs';

function makeSummary(overrides = {}) {
  return {
    startedAt: '2026-04-21T16-00-00-000Z',
    profile: 'ci-linux',
    results: [
      {
        id: 'resize-cycle',
        ok: true,
        metrics: { avgMs: 0.3, p99Ms: 1.2 },
      },
      {
        id: 'top-60s',
        ok: true,
        metrics: { feedP99Ms: 50, renderP99Ms: 48, heapDeltaMb: 20 },
      },
      {
        id: 'watch-60s',
        ok: true,
        metrics: { feedP99Ms: 40, renderP99Ms: 42, heapDeltaMb: 18 },
      },
      {
        id: 'yes-1gb',
        ok: true,
        metrics: { feedP99Ms: 2500 },
      },
    ],
    ...overrides,
  };
}

test('TRACKED_METRICS contains the nine canonical metric rows', () => {
  assert.equal(TRACKED_METRICS.length, 9);
  // Must include at least one top-60s and one watch-60s feed P99.
  assert.ok(TRACKED_METRICS.some((t) => t.specId === 'top-60s' && t.metric === 'feedP99Ms'));
  assert.ok(TRACKED_METRICS.some((t) => t.specId === 'watch-60s' && t.metric === 'feedP99Ms'));
});

test('parseArgs handles default + override', () => {
  const d = parseArgs([]);
  assert.equal(d.historyBranch, 'main');
  assert.equal(d.historyLimit, 7);
  assert.equal(d.deltaThreshold, 0.2);

  const o = parseArgs([
    '--current',
    'x.json',
    '--history-branch',
    'release',
    '--history-limit',
    '3',
    '--delta-threshold',
    '0.5',
  ]);
  assert.equal(o.current, 'x.json');
  assert.equal(o.historyBranch, 'release');
  assert.equal(o.historyLimit, 3);
  assert.equal(o.deltaThreshold, 0.5);
});

test('extractMetrics pulls tracked metrics out of a summary', () => {
  const m = extractMetrics(makeSummary());
  assert.equal(m['top-60s/feedP99Ms'], 50);
  assert.equal(m['watch-60s/renderP99Ms'], 42);
  assert.equal(m['yes-1gb/feedP99Ms'], 2500);
  assert.equal(m['resize-cycle/p99Ms'], 1.2);
});

test('extractMetrics tolerates missing spec metrics', () => {
  const m = extractMetrics({
    results: [{ id: 'top-60s', metrics: { feedP99Ms: 10 } }],
  });
  assert.equal(m['top-60s/feedP99Ms'], 10);
  assert.equal(m['top-60s/renderP99Ms'], undefined);
});

test('median computes correctly over odd and even lengths', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  // Order-independent.
  assert.equal(median([10, 1, 5, 2, 3]), 3);
});

test('judgeMetric flags regression beyond threshold', () => {
  const r = judgeMetric(60, 50, 0.1); // +20% > 10%
  assert.equal(r.verdict, 'regressed');
  assert.ok(r.delta > 0.19 && r.delta < 0.21);
});

test('judgeMetric passes within threshold', () => {
  const r = judgeMetric(52, 50, 0.2); // +4%
  assert.equal(r.verdict, 'pass');
});

test('judgeMetric reports improvement', () => {
  const r = judgeMetric(30, 50, 0.2); // -40%
  assert.equal(r.verdict, 'improved');
  assert.ok(r.delta < -0.3);
});

test('judgeMetric returns no-data when history is null', () => {
  assert.equal(judgeMetric(10, null, 0.2).verdict, 'no-data');
});

test('judgeMetric never regresses sub-ms noise-floor metrics', () => {
  // historyMedian < 1.0ms — even a +100% delta should pass.
  const r = judgeMetric(0.6, 0.3, 0.2);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.noiseFloor, true);
});

test('compareSummaries returns regressed=true when any metric breaches threshold', () => {
  const current = makeSummary({
    results: [
      { id: 'resize-cycle', metrics: { avgMs: 0.3, p99Ms: 1.2 } },
      // +50% regression on top-60s feed P99
      { id: 'top-60s', metrics: { feedP99Ms: 75, renderP99Ms: 48, heapDeltaMb: 20 } },
      { id: 'watch-60s', metrics: { feedP99Ms: 40, renderP99Ms: 42, heapDeltaMb: 18 } },
      { id: 'yes-1gb', metrics: { feedP99Ms: 2500 } },
    ],
  });
  const baseline = makeSummary();
  const history = [baseline, baseline, baseline, baseline, baseline];
  const { rows, regressed } = compareSummaries(current, history, 0.2);
  assert.equal(regressed, true);
  const topRow = rows.find((r) => r.key === 'top-60s/feedP99Ms');
  assert.equal(topRow.verdict, 'regressed');
  assert.ok(topRow.delta > 0.45);
});

test('compareSummaries returns regressed=false when all within threshold', () => {
  const current = makeSummary();
  const history = [makeSummary(), makeSummary(), makeSummary()];
  const { regressed } = compareSummaries(current, history, 0.2);
  assert.equal(regressed, false);
});

test('compareSummaries tolerates missing metrics in current (no-data)', () => {
  const current = {
    results: [{ id: 'resize-cycle', metrics: { avgMs: 0.3, p99Ms: 1.2 } }],
  };
  const history = [makeSummary(), makeSummary()];
  const { rows, regressed } = compareSummaries(current, history, 0.2);
  // Missing metrics are no-data — not a regression.
  assert.equal(regressed, false);
  const topRow = rows.find((r) => r.key === 'top-60s/feedP99Ms');
  assert.equal(topRow.verdict, 'no-data');
});

test('DEFAULT_PER_METRIC_THRESHOLDS widens yes-1gb feed P99 to 30%', () => {
  assert.equal(DEFAULT_PER_METRIC_THRESHOLDS['yes-1gb/feedP99Ms'], 0.3);
});

test('parseArgs accepts --per-metric-thresholds JSON and merges over defaults', () => {
  const o = parseArgs([
    '--per-metric-thresholds',
    '{"top-60s/feedP99Ms": 0.25, "resize-cycle/p99Ms": 0.5}',
  ]);
  // Default preserved for yes-1gb.
  assert.equal(o.perMetricThresholds['yes-1gb/feedP99Ms'], 0.3);
  // Override applied for top-60s.
  assert.equal(o.perMetricThresholds['top-60s/feedP99Ms'], 0.25);
  assert.equal(o.perMetricThresholds['resize-cycle/p99Ms'], 0.5);
});

test('parseArgs ignores malformed --per-metric-thresholds JSON', () => {
  const o = parseArgs(['--per-metric-thresholds', 'not-json']);
  // Defaults still present.
  assert.equal(o.perMetricThresholds['yes-1gb/feedP99Ms'], 0.3);
});

test('parseArgs ignores non-positive per-metric threshold values', () => {
  const o = parseArgs([
    '--per-metric-thresholds',
    '{"top-60s/feedP99Ms": -0.1, "watch-60s/feedP99Ms": 0}',
  ]);
  assert.equal(o.perMetricThresholds['top-60s/feedP99Ms'], undefined);
  assert.equal(o.perMetricThresholds['watch-60s/feedP99Ms'], undefined);
});

test('compareSummaries uses per-metric threshold to avoid flipping a noisy gate', () => {
  // yes-1gb feedP99 +25% regression: would fail at global 0.20 but pass
  // under the per-metric 0.30 ceiling. Real-world scenario — ubuntu runner
  // noise flipping a green gate.
  const current = makeSummary({
    results: [
      { id: 'resize-cycle', metrics: { avgMs: 0.3, p99Ms: 1.2 } },
      { id: 'top-60s', metrics: { feedP99Ms: 50, renderP99Ms: 48, heapDeltaMb: 20 } },
      { id: 'watch-60s', metrics: { feedP99Ms: 40, renderP99Ms: 42, heapDeltaMb: 18 } },
      { id: 'yes-1gb', metrics: { feedP99Ms: 3125 } }, // +25% vs baseline 2500
    ],
  });
  const baseline = makeSummary();
  const history = [baseline, baseline, baseline, baseline, baseline];

  // At the global 0.20 threshold, yes-1gb regresses.
  const globalRun = compareSummaries(current, history, 0.2);
  assert.equal(globalRun.regressed, true);

  // With the default per-metric override (0.30 for yes-1gb), it passes.
  const overrideRun = compareSummaries(current, history, 0.2, {
    ...DEFAULT_PER_METRIC_THRESHOLDS,
  });
  assert.equal(overrideRun.regressed, false);
  const yesRow = overrideRun.rows.find((r) => r.key === 'yes-1gb/feedP99Ms');
  assert.equal(yesRow.verdict, 'pass');
  assert.equal(yesRow.thresholdUsed, 0.3);
});

test('compareSummaries still regresses when delta exceeds even the per-metric ceiling', () => {
  const current = makeSummary({
    results: [
      { id: 'resize-cycle', metrics: { avgMs: 0.3, p99Ms: 1.2 } },
      { id: 'top-60s', metrics: { feedP99Ms: 50, renderP99Ms: 48, heapDeltaMb: 20 } },
      { id: 'watch-60s', metrics: { feedP99Ms: 40, renderP99Ms: 42, heapDeltaMb: 18 } },
      { id: 'yes-1gb', metrics: { feedP99Ms: 4000 } }, // +60% vs baseline 2500
    ],
  });
  const baseline = makeSummary();
  const history = [baseline, baseline, baseline];
  const run = compareSummaries(current, history, 0.2, {
    ...DEFAULT_PER_METRIC_THRESHOLDS,
  });
  assert.equal(run.regressed, true);
  const yesRow = run.rows.find((r) => r.key === 'yes-1gb/feedP99Ms');
  assert.equal(yesRow.verdict, 'regressed');
  assert.equal(yesRow.thresholdUsed, 0.3);
});
