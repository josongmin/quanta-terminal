#!/usr/bin/env node
/**
 * compare.test.mjs — drift-detection unit tests for ship-signoff-gen.
 *
 * Run: `node --test tools/ship-signoff-gen/__tests__/compare.test.mjs`
 * Node built-ins only — no external deps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSignoff,
  compareSignoffs,
  formatDriftReport,
} from '../compare.mjs';

/**
 * Build a minimal SHIP_SIGNOFF-shaped markdown with the provided gate
 * verdict map, matching the header/table structure `parseSignoff` scans.
 */
function buildDoc(verdicts, evidence = {}) {
  const header = `# Plan 0005 P0 — Ship Sign-off

- **Date**: 2026-04-21
- **Commit**: \`abc\`
- **Auditor**: test
- **Status**: **SHIP**

## Gate-by-gate

| # | Description | Verdict | Evidence |
|---|-------------|---------|----------|
`;
  const rows = Object.entries(verdicts)
    .map(
      ([id, v]) =>
        `| ${id} | Gate ${id} title | ${v === 'DEFERRED' ? '**DEFERRED**' : v} | ${evidence[id] || 'some evidence'} |`,
    )
    .join('\n');
  return header + rows + '\n';
}

test('parseSignoff extracts gate verdicts from a well-formed doc', () => {
  const md = buildDoc({ 1: 'GREEN', 2: 'YELLOW', 5: 'DEFERRED' });
  const parsed = parseSignoff(md);
  assert.equal(parsed.gates[1].verdict, 'GREEN');
  assert.equal(parsed.gates[2].verdict, 'YELLOW');
  assert.equal(parsed.gates[5].verdict, 'DEFERRED');
  assert.equal(parsed.warnings.length, 0);
});

test('compareSignoffs: no-change scenario yields empty diff + alertCount=0', () => {
  const md = buildDoc({ 1: 'GREEN', 2: 'GREEN', 7: 'YELLOW' });
  const a = parseSignoff(md);
  const b = parseSignoff(md);
  const diff = compareSignoffs(a, b);
  assert.equal(diff.alertCount, 0);
  assert.equal(diff.regressed.length, 0);
  assert.equal(diff.improved.length, 0);
  assert.equal(diff.evidenceOnly.length, 0);
});

test('compareSignoffs: GREEN→YELLOW is an alerting regression', () => {
  const prev = parseSignoff(buildDoc({ 1: 'GREEN' }));
  const now = parseSignoff(buildDoc({ 1: 'YELLOW' }));
  const diff = compareSignoffs(prev, now);
  assert.equal(diff.alertCount, 1);
  assert.equal(diff.regressed[0].id, 1);
  assert.equal(diff.regressed[0].from, 'GREEN');
  assert.equal(diff.regressed[0].to, 'YELLOW');
  assert.equal(diff.regressed[0].tier, 2);
});

test('compareSignoffs: YELLOW→RED is an alerting regression (tier 3)', () => {
  const prev = parseSignoff(buildDoc({ 7: 'YELLOW' }));
  const now = parseSignoff(buildDoc({ 7: 'RED' }));
  const diff = compareSignoffs(prev, now);
  assert.equal(diff.alertCount, 1);
  assert.equal(diff.regressed[0].tier, 3);
});

test('compareSignoffs: GREEN→RED is an alerting regression (tier 3)', () => {
  const prev = parseSignoff(buildDoc({ 3: 'GREEN' }));
  const now = parseSignoff(buildDoc({ 3: 'RED' }));
  const diff = compareSignoffs(prev, now);
  assert.equal(diff.alertCount, 1);
  assert.equal(diff.regressed[0].tier, 3);
});

test('compareSignoffs: YELLOW→GREEN is an improvement, not alerting', () => {
  const prev = parseSignoff(buildDoc({ 7: 'YELLOW' }));
  const now = parseSignoff(buildDoc({ 7: 'GREEN' }));
  const diff = compareSignoffs(prev, now);
  assert.equal(diff.alertCount, 0);
  assert.equal(diff.improved.length, 1);
  assert.equal(diff.improved[0].from, 'YELLOW');
  assert.equal(diff.improved[0].to, 'GREEN');
});

test('compareSignoffs: evidence-only change (same verdict) is reported but not alerting', () => {
  const prev = parseSignoff(buildDoc({ 1: 'GREEN' }, { 1: 'exit=0 files=100' }));
  const now = parseSignoff(buildDoc({ 1: 'GREEN' }, { 1: 'exit=0 files=200' }));
  const diff = compareSignoffs(prev, now);
  assert.equal(diff.alertCount, 0);
  assert.equal(diff.evidenceOnly.length, 1);
  assert.equal(diff.evidenceOnly[0].id, 1);
});

test('compareSignoffs: added and removed gates are tracked', () => {
  const prev = parseSignoff(buildDoc({ 1: 'GREEN' }));
  const now = parseSignoff(buildDoc({ 1: 'GREEN', 2: 'GREEN' }));
  const diff = compareSignoffs(prev, now);
  assert.deepEqual(diff.added, [2]);
  assert.equal(diff.removed.length, 0);
});

test('parseSignoff: malformed rows produce warnings but do not crash', () => {
  const md = `# t

| # | Description | Verdict | Evidence |
|---|-------------|---------|----------|
| abc | bad-id | GREEN | x |
| 1 | ok | GREEN | y |
| 2 | bad-verdict | PURPLE | z |
`;
  const parsed = parseSignoff(md);
  assert.equal(parsed.gates[1].verdict, 'GREEN');
  assert.equal(parsed.gates[2], undefined);
  assert.ok(parsed.warnings.length >= 2, `got warnings=${JSON.stringify(parsed.warnings)}`);
});

test('formatDriftReport: regressions appear in body', () => {
  const diff = {
    regressed: [{ id: 1, from: 'GREEN', to: 'YELLOW', tier: 2 }],
    improved: [],
    evidenceOnly: [],
    added: [],
    removed: [],
    alertCount: 1,
  };
  const body = formatDriftReport(diff, { date: '2026-04-21' });
  assert.match(body, /drift report — 2026-04-21/u);
  assert.match(body, /1 alerting regression/u);
  assert.match(body, /Gate 1: GREEN → YELLOW/u);
});

test('formatDriftReport: no-drift body is clean and states "No alerting regressions."', () => {
  const diff = {
    regressed: [],
    improved: [],
    evidenceOnly: [],
    added: [],
    removed: [],
    alertCount: 0,
  };
  const body = formatDriftReport(diff, { date: '2026-04-21' });
  assert.match(body, /No alerting regressions/u);
});

test('compareSignoffs: DEFERRED transitions are never alerting', () => {
  const prev = parseSignoff(buildDoc({ 5: 'DEFERRED' }));
  const now = parseSignoff(buildDoc({ 5: 'RED' }));
  const diff = compareSignoffs(prev, now);
  assert.equal(diff.alertCount, 0);
  assert.equal(diff.improved.length, 1);
});
