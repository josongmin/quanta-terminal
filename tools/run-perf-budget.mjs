#!/usr/bin/env node
/**
 * tools/run-perf-budget.mjs — CLI runner for the Plan 0005 P0 Gate #7 / #10
 * perf-budget tests.
 *
 * Usage
 * -----
 *   pnpm test:perf
 *   node tools/run-perf-budget.mjs
 *
 * What it does
 * ------------
 *  1. Spawns `vitest run` on each of the four perf-budget specs under
 *     `packages/ui/src/__tests__/perf/`, in sequence (parallelism = 1 so
 *     timing measurements don't contaminate each other).
 *  2. Captures each spec's structured `[perf:<id>] {...}` console line from
 *     stdout and aggregates them.
 *  3. Writes a JSON report to `artifacts/perf/<timestamp>.json`.
 *  4. Prints a human-readable PASS/WARN/FAIL table to the terminal.
 *  5. Exits non-zero if any test process failed OR any verdict is FAIL.
 *
 * Design choices
 * --------------
 *  - No external dependencies. Pure Node 20+.
 *  - `--expose-gc` is forwarded to the vitest child so `global.gc()` is
 *    available to the memory-snapshot helper.
 *  - Each spec gets its own `vitest run <path>` invocation — that gives us
 *    process-isolated heap readings (one test's heap won't leak into
 *    another's).
 *  - Retries are left to vitest's `--retry` flag; the runner does a single
 *    pass. Users that want rerun-until-stable can wrap this script.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const UI_DIR = path.join(REPO_ROOT, 'packages', 'ui');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'perf');

/**
 * Budget profiles. The `local` profile matches the canonical
 * `PERF_BUDGETS` in `packages/ui/src/__tests__/perf/perf-budget.ts`.
 * The `ci-linux` profile matches the `CI_LINUX_BUDGETS` export —
 * ~3× wider to absorb the ubuntu-24.04 GitHub runner penalty.
 *
 * Kept in-process (rather than dynamically imported from the .ts file)
 * because this runner is a pure node.mjs script with no transpiler
 * hook. When you touch these numbers, update perf-budget.ts in the
 * same change — the `perf-budget-resolver.test.mjs` test locks the
 * two sources together.
 */
export const BUDGET_PROFILES = {
  local: {
    feedLatencyP99Ms: 128,
    renderFrameBudgetP99Ms: 128,
    resizeDurationAvgMs: 12,
    resizeDurationP99Ms: 32,
    topMemoryCeilingMb: 50,
    stressScrollbackCeilingRows: 10_000,
    yesStreamFeedP99Ms: 10_000,
  },
  'ci-linux': {
    feedLatencyP99Ms: 384,
    renderFrameBudgetP99Ms: 384,
    resizeDurationAvgMs: 36,
    resizeDurationP99Ms: 96,
    topMemoryCeilingMb: 150,
    stressScrollbackCeilingRows: 10_000,
    yesStreamFeedP99Ms: 30_000,
  },
};

/**
 * Resolve the active profile. Unknown profile names fall back to
 * `local` (never silently disable the budget).
 */
export function resolveProfile(name) {
  if (name === 'ci-linux') return { id: 'ci-linux', budgets: BUDGET_PROFILES['ci-linux'] };
  return { id: 'local', budgets: BUDGET_PROFILES['local'] };
}

/**
 * Build the SPECS list against the supplied profile. Keeping the spec
 * descriptors (id, relPath, metrics list) pure and pulling the
 * numbers from the profile means a single source of truth per profile
 * and zero divergence between `local` and `ci-linux` spec shapes.
 */
export function buildSpecs(profile) {
  const b = profile.budgets;
  return [
    {
      id: 'resize-cycle',
      relPath: 'src/__tests__/perf/resize-cycle.test.ts',
      budgets: [
        { metric: 'avgMs', budget: b.resizeDurationAvgMs, key: 'resizeDurationAvgMs' },
        { metric: 'p99Ms', budget: b.resizeDurationP99Ms, key: 'resizeDurationP99Ms' },
      ],
    },
    {
      id: 'top-60s',
      relPath: 'src/__tests__/perf/top-60s-budget.test.ts',
      budgets: [
        { metric: 'feedP99Ms', budget: b.feedLatencyP99Ms, key: 'feedLatencyP99Ms' },
        { metric: 'renderP99Ms', budget: b.renderFrameBudgetP99Ms, key: 'renderFrameBudgetP99Ms' },
        { metric: 'heapDeltaMb', budget: b.topMemoryCeilingMb, key: 'topMemoryCeilingMb' },
      ],
    },
    {
      id: 'watch-60s',
      relPath: 'src/__tests__/perf/watch-60s-budget.test.ts',
      budgets: [
        { metric: 'feedP99Ms', budget: b.feedLatencyP99Ms, key: 'feedLatencyP99Ms' },
        { metric: 'renderP99Ms', budget: b.renderFrameBudgetP99Ms, key: 'renderFrameBudgetP99Ms' },
        { metric: 'heapDeltaMb', budget: b.topMemoryCeilingMb, key: 'topMemoryCeilingMb' },
      ],
    },
    {
      id: 'yes-1gb',
      relPath: 'src/__tests__/perf/yes-1gb-budget.test.ts',
      budgets: [
        { metric: 'feedP99Ms', budget: b.yesStreamFeedP99Ms, key: 'yesStreamFeedP99Ms' },
        {
          metric: 'scrollbackRows',
          budget: b.stressScrollbackCeilingRows,
          key: 'stressScrollbackCeilingRows',
        },
      ],
    },
  ];
}

const ACTIVE_PROFILE = resolveProfile(process.env.PERF_PROFILE);
const SPECS = buildSpecs(ACTIVE_PROFILE);

/**
 * Run a single perf spec. Returns `{ ok, metrics, stdout, stderr }`.
 * `metrics` is the parsed `[perf:<id>] {...}` line; `ok` reflects the
 * child's exit status.
 */
async function runSpec(spec) {
  return new Promise((resolve) => {
    const args = [
      '--expose-gc',
      './node_modules/vitest/vitest.mjs',
      'run',
      spec.relPath,
      '--config',
      './vitest.config.ts',
    ];
    const child = spawn(process.execPath, args, {
      cwd: UI_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Flip on perf-test inclusion in vitest.config.ts.
        VITEST_PERF: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --expose-gc`.trim(),
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      const metricsLine = findStructuredLine(stdout, spec.id);
      let metrics = null;
      if (metricsLine) {
        try {
          metrics = JSON.parse(metricsLine);
        } catch {
          metrics = null;
        }
      }
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        metrics,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Extract the JSON payload from a console line of the form
 *   `[perf:<id>] {...}`
 * Returns the first such line's JSON body, or null if not found.
 */
function findStructuredLine(stdout, id) {
  const marker = `[perf:${id}]`;
  const lines = stdout.split('\n');
  for (const line of lines) {
    const idx = line.indexOf(marker);
    if (idx === -1) continue;
    const body = line.slice(idx + marker.length).trim();
    if (body.startsWith('{')) return body;
  }
  return null;
}

const WARN_TOLERANCE = 0.1;
function verdict(actual, budget) {
  if (actual <= budget) return 'PASS';
  if (actual <= budget * (1 + WARN_TOLERANCE)) return 'WARN';
  return 'FAIL';
}

function padRight(s, w) {
  s = String(s);
  if (s.length >= w) return s;
  return s + ' '.repeat(w - s.length);
}

function main() {
  return (async () => {
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const commit = process.env.GITHUB_SHA || process.env.PERF_COMMIT || 'local';
    const commitShort = commit.slice(0, 12);
    const commitDir = path.join(ARTIFACT_DIR, commitShort);
    await fs.mkdir(commitDir, { recursive: true });
    // Primary artefact (flat file, back-compat with existing consumers) +
    // commit-scoped copy used by `tools/perf-regression-check.mjs`.
    const outFile = path.join(ARTIFACT_DIR, `${timestamp}.json`);
    const summaryFile = path.join(commitDir, 'summary.json');

    const results = [];
    let anyFail = false;
    for (const spec of SPECS) {
      process.stdout.write(`[perf] running ${spec.id}... `);
      const t0 = Date.now();
      const r = await runSpec(spec);
      const durMs = Date.now() - t0;
      process.stdout.write(`${r.ok ? 'ok' : 'FAIL'} (${durMs} ms)\n`);

      if (!r.ok) {
        anyFail = true;
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
      }

      const verdicts = [];
      if (r.metrics) {
        for (const b of spec.budgets) {
          const actual = r.metrics[b.metric];
          if (typeof actual !== 'number') {
            verdicts.push({
              metric: b.metric,
              budget: b.budget,
              actual: null,
              verdict: 'FAIL',
              reason: 'metric missing',
            });
            anyFail = true;
            continue;
          }
          const v = verdict(actual, b.budget);
          if (v === 'FAIL') anyFail = true;
          verdicts.push({ metric: b.metric, budget: b.budget, actual, verdict: v });
        }
      }
      results.push({
        id: spec.id,
        ok: r.ok,
        durationMs: durMs,
        metrics: r.metrics,
        verdicts,
      });
    }

    const summary = {
      startedAt: timestamp,
      repo: 'quanta-terminal',
      profile: ACTIVE_PROFILE.id,
      profileBudgets: ACTIVE_PROFILE.budgets,
      commit,
      results,
      allPass: !anyFail,
    };
    await fs.writeFile(outFile, JSON.stringify(summary, null, 2), 'utf8');
    await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
    // Emit a small README next to the summary explaining what the file is.
    // Auto-generated; regression-check tool reads summary.json only.
    const readmeBody =
      `# Perf budget report\n\n` +
      `Commit: \`${commit}\`\n` +
      `Profile: \`${ACTIVE_PROFILE.id}\`\n` +
      `Started: \`${timestamp}\`\n` +
      `Status: **${anyFail ? 'FAIL' : 'PASS'}**\n\n` +
      `See \`summary.json\` for machine-readable metrics and verdicts.\n` +
      `Generated by \`tools/run-perf-budget.mjs\`.\n`;
    await fs.writeFile(path.join(commitDir, 'README.md'), readmeBody, 'utf8');

    // Human-readable table.
    process.stdout.write(`\n=== Perf budget summary (profile=${ACTIVE_PROFILE.id}) ===\n`);
    process.stdout.write(
      padRight('spec', 16) +
        padRight('metric', 18) +
        padRight('actual', 14) +
        padRight('budget', 10) +
        'verdict\n',
    );
    process.stdout.write('-'.repeat(66) + '\n');
    for (const r of results) {
      if (!r.metrics) {
        process.stdout.write(
          padRight(r.id, 16) +
            padRight('-', 18) +
            padRight('-', 14) +
            padRight('-', 10) +
            (r.ok ? 'NO METRICS' : 'CRASHED') +
            '\n',
        );
        continue;
      }
      for (const v of r.verdicts) {
        process.stdout.write(
          padRight(r.id, 16) +
            padRight(v.metric, 18) +
            padRight(String(v.actual ?? '-'), 14) +
            padRight(String(v.budget), 10) +
            v.verdict +
            '\n',
        );
      }
    }
    process.stdout.write(`\nReport: ${path.relative(REPO_ROOT, outFile)}\n`);
    process.stdout.write(
      anyFail ? '\nSTATUS: FAIL (one or more budgets overshot)\n' : '\nSTATUS: PASS\n',
    );
    process.exit(anyFail ? 1 : 0);
  })();
}

// Only auto-run when invoked as a CLI, not when imported for tests.
const INVOKED_AS_CLI =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_AS_CLI) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('run-perf-budget: fatal', err);
    process.exit(2);
  });
}
