#!/usr/bin/env node
/**
 * Workflow-assertion test for `.github/workflows/perf-budget.yml`.
 *
 * Plan 0005 P1-H — Linux 3x budget enforcement. The workflow now computes
 * `--delta-threshold` dynamically: 0.60 on Linux (3 * the macOS baseline of
 * 0.20) and 0.20 elsewhere. This test is a cheap tripwire that catches a
 * future edit that silently hardcodes the threshold again — which would
 * re-introduce the "regression-check fires on noise" symptom the audit
 * flagged.
 *
 * Run directly: `node --test tools/__tests__/perf-budget-yaml.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(here, '..', '..', '.github', 'workflows', 'perf-budget.yml');
const yaml = readFileSync(workflowPath, 'utf8');

test('perf-budget.yml computes a dynamic threshold based on runner.os', () => {
  // The step must branch on runner.os. We don't parse YAML — a plain
  // substring check is enough to catch a revert to the hardcoded 0.20.
  assert.match(
    yaml,
    /runner\.os.*=.*["']?Linux["']?/,
    'workflow must branch on runner.os to widen threshold on Linux',
  );
});

test('perf-budget.yml uses 0.60 threshold on Linux (3x macOS baseline)', () => {
  assert.match(
    yaml,
    /THRESH=0\.60/,
    'Linux branch must set the 3x tolerance (0.60)',
  );
});

test('perf-budget.yml keeps 0.20 threshold elsewhere', () => {
  assert.match(
    yaml,
    /THRESH=0\.20/,
    'non-Linux branch must keep the macOS baseline (0.20)',
  );
});

test('perf-budget.yml passes threshold via the --delta-threshold flag', () => {
  assert.match(
    yaml,
    /--delta-threshold\s+"?\$\{?THRESH\}?/,
    'must pass the computed THRESH via --delta-threshold',
  );
});

test('perf-budget.yml no longer hardcodes --delta-threshold 0.20 directly', () => {
  // The old form `--delta-threshold 0.20` (no variable) must not appear —
  // that would mean a revert / partial edit.
  const hardcoded = /--delta-threshold\s+0\.20\b/.test(yaml);
  assert.equal(
    hardcoded,
    false,
    'hardcoded --delta-threshold 0.20 would mask the Linux noise floor',
  );
});

test('perf-budget.yml retains baseline artifacts 90 days on main, 30 days on PR', () => {
  // Main branch runs feed the history-limit-7 median used by the
  // regression check. A flat 30-day retention starves the check on
  // quiet repos; this assertion locks the main/PR ratchet in place.
  assert.match(
    yaml,
    /retention-days:\s*\$\{\{\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]\s*&&\s*90\s*\|\|\s*30\s*\}\}/,
    'retention-days must be 90 on main, 30 on PRs (conditional expression)',
  );
});
