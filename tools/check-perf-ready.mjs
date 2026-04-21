#!/usr/bin/env node
/**
 * tools/check-perf-ready.mjs — Plan 0005 P1-H local smoke test.
 *
 * Verifies the perf-budget wiring is structurally sound *before* we
 * push to CI. Runs in ≤ 5 seconds and never spawns the full vitest
 * harness (the real spec takes ~90 s and is what `pnpm test:perf`
 * covers).
 *
 * Checks:
 *   1. `.github/workflows/perf-budget.yml` parses as YAML and has the
 *      expected top-level keys.
 *   2. `packages/ui/src/__tests__/perf/perf-budget.ts` exports both
 *      `PERF_BUDGETS` and `CI_LINUX_BUDGETS` (via grep — we don't run
 *      ts-node).
 *   3. `tools/run-perf-budget.mjs` imports cleanly and exposes the
 *      expected `BUDGET_PROFILES` / `resolveProfile` / `buildSpecs`.
 *   4. `tools/perf-regression-check.mjs` imports cleanly and exposes
 *      the expected helpers.
 *   5. `BUDGET_PROFILES` has both `local` and `ci-linux` profiles and
 *      their keys match.
 *
 * Exits non-zero on any failure.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'perf-budget.yml');
const BUDGET_TS_PATH = path.join(
  REPO_ROOT,
  'packages',
  'ui',
  'src',
  '__tests__',
  'perf',
  'perf-budget.ts',
);
const RUNNER_PATH = path.join(REPO_ROOT, 'tools', 'run-perf-budget.mjs');
const REGRESSION_PATH = path.join(REPO_ROOT, 'tools', 'perf-regression-check.mjs');

const failures = [];

function fail(message) {
  failures.push(message);
  process.stderr.write(`FAIL: ${message}\n`);
}

function ok(message) {
  process.stdout.write(`OK: ${message}\n`);
}

/**
 * Minimal YAML sanity check. We deliberately avoid pulling in a YAML
 * parser — instead we look for the key structural markers we expect
 * to see. Full YAML validity gets caught by GitHub when the workflow
 * runs; here we just guard the top-level skeleton.
 */
async function checkWorkflow() {
  let text;
  try {
    text = await fs.readFile(WORKFLOW_PATH, 'utf8');
  } catch (err) {
    fail(`workflow not readable: ${err.message}`);
    return;
  }
  const mustContain = [
    /^name:\s*perf-budget/m,
    /runs-on:\s*ubuntu-24\.04/m,
    /PERF_PROFILE:\s*ci-linux/,
    /retention-days:\s*30/,
    /pnpm test:perf/,
    /perf-regression-check\.mjs/,
  ];
  for (const re of mustContain) {
    if (!re.test(text)) {
      fail(`workflow missing required pattern ${re}`);
      return;
    }
  }
  // Light structural check — indentation-based, no eval.
  if (!/^jobs:/m.test(text) || !/^on:/m.test(text)) {
    fail('workflow missing jobs: / on: top-level keys');
    return;
  }
  ok('perf-budget.yml structural check');
}

async function checkBudgetTs() {
  let text;
  try {
    text = await fs.readFile(BUDGET_TS_PATH, 'utf8');
  } catch (err) {
    fail(`perf-budget.ts not readable: ${err.message}`);
    return;
  }
  const mustContain = [
    /export const PERF_BUDGETS/,
    /export const CI_LINUX_BUDGETS/,
    /export function resolveBudgets/,
    /feedLatencyP99Ms/,
  ];
  for (const re of mustContain) {
    if (!re.test(text)) {
      fail(`perf-budget.ts missing ${re}`);
      return;
    }
  }
  ok('perf-budget.ts exports are present');
}

async function checkRunner() {
  let mod;
  try {
    mod = await import(RUNNER_PATH);
  } catch (err) {
    fail(`run-perf-budget.mjs import failed: ${err.message}`);
    return;
  }
  if (!mod.BUDGET_PROFILES) return fail('run-perf-budget.mjs missing BUDGET_PROFILES');
  if (typeof mod.resolveProfile !== 'function')
    return fail('run-perf-budget.mjs missing resolveProfile()');
  if (typeof mod.buildSpecs !== 'function') return fail('run-perf-budget.mjs missing buildSpecs()');

  if (!mod.BUDGET_PROFILES.local || !mod.BUDGET_PROFILES['ci-linux']) {
    return fail('BUDGET_PROFILES must have both local and ci-linux');
  }

  const localKeys = Object.keys(mod.BUDGET_PROFILES.local).sort();
  const ciKeys = Object.keys(mod.BUDGET_PROFILES['ci-linux']).sort();
  if (localKeys.join(',') !== ciKeys.join(',')) {
    return fail(
      `BUDGET_PROFILES local/ci-linux keys diverge: local=[${localKeys}] ci-linux=[${ciKeys}]`,
    );
  }

  // ci-linux must be ≥ local on every timing metric (not a strict rule
  // for invariants like scrollback rows).
  const timingMetrics = [
    'feedLatencyP99Ms',
    'renderFrameBudgetP99Ms',
    'resizeDurationAvgMs',
    'resizeDurationP99Ms',
    'topMemoryCeilingMb',
    'yesStreamFeedP99Ms',
  ];
  for (const m of timingMetrics) {
    if (mod.BUDGET_PROFILES['ci-linux'][m] < mod.BUDGET_PROFILES.local[m]) {
      return fail(
        `ci-linux ${m} (${mod.BUDGET_PROFILES['ci-linux'][m]}) < local (${mod.BUDGET_PROFILES.local[m]})`,
      );
    }
  }

  // resolveProfile sanity.
  if (mod.resolveProfile('ci-linux').id !== 'ci-linux') {
    return fail('resolveProfile("ci-linux") did not return ci-linux');
  }
  if (mod.resolveProfile(undefined).id !== 'local') {
    return fail('resolveProfile(undefined) did not fall back to local');
  }
  if (mod.resolveProfile('bogus').id !== 'local') {
    return fail('resolveProfile("bogus") did not fall back to local');
  }

  // buildSpecs shape.
  const specs = mod.buildSpecs(mod.resolveProfile('local'));
  if (!Array.isArray(specs) || specs.length !== 4) {
    return fail(`buildSpecs returned ${specs?.length} specs, expected 4`);
  }
  ok('run-perf-budget.mjs exports + profile keys agree');
}

async function checkRegressionTool() {
  let mod;
  try {
    mod = await import(REGRESSION_PATH);
  } catch (err) {
    fail(`perf-regression-check.mjs import failed: ${err.message}`);
    return;
  }
  const required = [
    'TRACKED_METRICS',
    'parseArgs',
    'extractMetrics',
    'median',
    'judgeMetric',
    'compareSummaries',
  ];
  for (const name of required) {
    if (mod[name] === undefined) {
      return fail(`perf-regression-check.mjs missing export: ${name}`);
    }
  }
  ok('perf-regression-check.mjs exports present');
}

async function main() {
  await checkWorkflow();
  await checkBudgetTs();
  await checkRunner();
  await checkRegressionTool();

  if (failures.length > 0) {
    process.stderr.write(`\ncheck-perf-ready: ${failures.length} failure(s)\n`);
    process.exit(1);
  }
  process.stdout.write('\ncheck-perf-ready: all checks passed\n');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('check-perf-ready: fatal', err);
  process.exit(2);
});
