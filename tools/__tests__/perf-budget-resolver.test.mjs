#!/usr/bin/env node
/**
 * Tests for the profile-resolution surface of
 * `tools/run-perf-budget.mjs`.
 *
 * We verify:
 *   1. `resolveProfile('local')` returns the local profile.
 *   2. `resolveProfile('ci-linux')` returns the wider CI profile.
 *   3. Unknown/undefined profile names fall back to local (never
 *      silently disable the budget).
 *   4. `buildSpecs(profile)` builds a SPECS array whose budget values
 *      match the profile.
 *   5. ci-linux budgets are strictly ≥ local budgets on every timing
 *      metric (invariant: a CI run should never have a tighter
 *      ceiling than the local dev run).
 *
 * Run directly: `node --test tools/__tests__/perf-budget-resolver.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_PROFILES, resolveProfile, buildSpecs } from '../run-perf-budget.mjs';

test('resolveProfile("local") yields the local budget set', () => {
  const p = resolveProfile('local');
  assert.equal(p.id, 'local');
  assert.equal(p.budgets, BUDGET_PROFILES.local);
  assert.equal(p.budgets.feedLatencyP99Ms, 128);
});

test('resolveProfile("ci-linux") yields the wider CI budget set', () => {
  const p = resolveProfile('ci-linux');
  assert.equal(p.id, 'ci-linux');
  assert.equal(p.budgets, BUDGET_PROFILES['ci-linux']);
  assert.equal(p.budgets.feedLatencyP99Ms, 384);
});

test('resolveProfile falls back to local on unknown/undefined input', () => {
  assert.equal(resolveProfile(undefined).id, 'local');
  assert.equal(resolveProfile(null).id, 'local');
  assert.equal(resolveProfile('').id, 'local');
  assert.equal(resolveProfile('macos-m4-max').id, 'local');
});

test('buildSpecs emits budgets matching the selected profile', () => {
  const local = buildSpecs(resolveProfile('local'));
  const ci = buildSpecs(resolveProfile('ci-linux'));
  assert.equal(local.length, 4);
  assert.equal(ci.length, 4);

  const localTop = local.find((s) => s.id === 'top-60s');
  const ciTop = ci.find((s) => s.id === 'top-60s');
  const localFeedP99 = localTop.budgets.find((b) => b.metric === 'feedP99Ms').budget;
  const ciFeedP99 = ciTop.budgets.find((b) => b.metric === 'feedP99Ms').budget;
  assert.equal(localFeedP99, 128);
  assert.equal(ciFeedP99, 384);
});

test('ci-linux profile has every timing metric ≥ local profile', () => {
  const local = BUDGET_PROFILES.local;
  const ci = BUDGET_PROFILES['ci-linux'];
  for (const key of Object.keys(local)) {
    // stressScrollbackCeilingRows is a ring-size invariant, not a
    // timing ceiling — identical in both profiles by design.
    if (key === 'stressScrollbackCeilingRows') {
      assert.equal(ci[key], local[key], `${key} should be identical across profiles`);
      continue;
    }
    assert.ok(
      ci[key] >= local[key],
      `ci-linux ${key} (${ci[key]}) should be >= local (${local[key]})`,
    );
  }
});

test('both profiles share the same key set', () => {
  const lk = Object.keys(BUDGET_PROFILES.local).sort().join(',');
  const ck = Object.keys(BUDGET_PROFILES['ci-linux']).sort().join(',');
  assert.equal(lk, ck);
});
