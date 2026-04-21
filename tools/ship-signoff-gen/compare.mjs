#!/usr/bin/env node
/**
 * compare.mjs — detect drift between committed and newly-generated
 * SHIP_SIGNOFF.md docs.
 *
 * Drift rules (per Plan 0005 P1-I):
 *   - GREEN → YELLOW : alert
 *   - GREEN → RED    : alert
 *   - YELLOW → RED   : alert
 *   - any other transition (flat, improvements, text-only evidence change):
 *     reported in the report but does NOT trigger an alert
 *
 * The parser is tolerant: it only looks for the gate-by-gate table rows
 * and reads the first-column integer as the gate ID and the verdict
 * token from the third column. Everything else is ignored.
 *
 * Zero npm deps.
 */

import { readFile } from 'node:fs/promises';

/** Verdict tokens we recognize. Order matters: match longer first. */
const VERDICT_TOKENS = ['DEFERRED', 'GREEN', 'YELLOW', 'RED'];

/**
 * Parse SHIP_SIGNOFF.md content → `{[gateId]: {verdict, evidence}}`.
 *
 * Accepts both plain and bold-marked verdict cells (e.g. `**DEFERRED**`).
 * Malformed table rows are skipped with a warning in `warnings`.
 */
export function parseSignoff(md) {
  const gates = {};
  const warnings = [];
  const lines = md.split('\n');
  let inTable = false;
  for (const line of lines) {
    if (/^\|\s*#\s*\|\s*Description/u.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable && /^\|\s*[-:|\s]+\|?\s*$/u.test(line)) {
      continue;
    }
    if (inTable && !line.startsWith('|')) {
      // Table ended.
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) {
      warnings.push(`malformed row: ${line}`);
      continue;
    }
    const idStr = cells[0];
    const id = Number(idStr);
    if (!Number.isFinite(id) || id <= 0) {
      warnings.push(`malformed id in row: ${line}`);
      continue;
    }
    const verdictRaw = cells[2].replace(/\*/g, '').trim().toUpperCase();
    const verdict = VERDICT_TOKENS.find((v) => verdictRaw === v) || null;
    if (!verdict) {
      warnings.push(`unknown verdict "${cells[2]}" in row: ${line}`);
      continue;
    }
    gates[id] = { verdict, evidence: cells[3] };
  }
  return { gates, warnings };
}

/**
 * Regression tiers. Higher tier = worse.
 *   0 = no regression
 *   1 = verdict changed but not a regression (text change or improvement)
 *   2 = GREEN → YELLOW
 *   3 = GREEN → RED
 *   3 = YELLOW → RED
 * (Tiers 2 and 3 are alerting; tier 1 is noise; tier 0 is unchanged.)
 */
function classifyTransition(from, to) {
  if (from === to) return 0;
  // DEFERRED never alerts on its own; treat it as a sidebar state.
  if (from === 'DEFERRED' || to === 'DEFERRED') return 1;
  if (from === 'GREEN' && to === 'YELLOW') return 2;
  if (from === 'GREEN' && to === 'RED') return 3;
  if (from === 'YELLOW' && to === 'RED') return 3;
  // improvements (YELLOW→GREEN, RED→*) are tier 1 (non-alerting).
  return 1;
}

/**
 * Produce a diff report from two parsed sign-off docs.
 *
 * Returns `{ regressed: Item[], improved: Item[], evidenceOnly: Item[],
 *            added: number[], removed: number[], alertCount: number }`.
 *
 * `regressed` contains only tier-2 + tier-3 transitions (the alerting ones).
 * `evidenceOnly` contains same-verdict-but-different-evidence rows.
 */
export function compareSignoffs(committed, generated) {
  const regressed = [];
  const improved = [];
  const evidenceOnly = [];
  const added = [];
  const removed = [];
  const allIds = new Set([
    ...Object.keys(committed.gates).map(Number),
    ...Object.keys(generated.gates).map(Number),
  ]);
  for (const id of [...allIds].sort((a, b) => a - b)) {
    const was = committed.gates[id];
    const now = generated.gates[id];
    if (was && !now) {
      removed.push(id);
      continue;
    }
    if (!was && now) {
      added.push(id);
      continue;
    }
    const tier = classifyTransition(was.verdict, now.verdict);
    if (tier >= 2) {
      regressed.push({ id, from: was.verdict, to: now.verdict, tier });
    } else if (tier === 1) {
      // verdict changed non-alerting (improvement OR DEFERRED transition).
      improved.push({ id, from: was.verdict, to: now.verdict });
    } else if (was.evidence !== now.evidence) {
      evidenceOnly.push({
        id,
        verdict: was.verdict,
        before: was.evidence,
        after: now.evidence,
      });
    }
  }
  return {
    regressed,
    improved,
    evidenceOnly,
    added,
    removed,
    alertCount: regressed.length,
  };
}

/** Format a human-readable drift report block. */
export function formatDriftReport(diff, { date } = {}) {
  const dateStr = date || new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# SHIP_SIGNOFF drift report — ${dateStr}`);
  lines.push('');
  if (diff.alertCount === 0) {
    lines.push('No alerting regressions.');
  } else {
    lines.push(`**${diff.alertCount} alerting regression(s) detected.**`);
  }
  lines.push('');
  if (diff.regressed.length > 0) {
    lines.push('## Regressed (alerting)');
    lines.push('');
    for (const r of diff.regressed) {
      lines.push(`- Gate ${r.id}: ${r.from} → ${r.to}`);
    }
    lines.push('');
  }
  if (diff.improved.length > 0) {
    lines.push('## Improved / non-alerting verdict change');
    lines.push('');
    for (const r of diff.improved) {
      lines.push(`- Gate ${r.id}: ${r.from} → ${r.to}`);
    }
    lines.push('');
  }
  if (diff.evidenceOnly.length > 0) {
    lines.push('## Evidence-only change (same verdict)');
    lines.push('');
    for (const r of diff.evidenceOnly) {
      lines.push(`- Gate ${r.id} (${r.verdict}): \`${r.before}\` → \`${r.after}\``);
    }
    lines.push('');
  }
  if (diff.added.length > 0) {
    lines.push(`## Added gates`);
    lines.push('');
    lines.push(diff.added.map((n) => `- Gate ${n}`).join('\n'));
    lines.push('');
  }
  if (diff.removed.length > 0) {
    lines.push(`## Removed gates`);
    lines.push('');
    lines.push(diff.removed.map((n) => `- Gate ${n}`).join('\n'));
    lines.push('');
  }
  return lines.join('\n');
}

/** Read a file → parsed sign-off. Returns `null` if the file does not exist. */
export async function readSignoffFile(path) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return parseSignoff(content);
}

/**
 * High-level entry: compare two files. If `committedPath` is missing,
 * every gate in `generatedPath` is treated as added and `alertCount=0`.
 */
export async function compareFiles(committedPath, generatedPath) {
  const committed = (await readSignoffFile(committedPath)) || {
    gates: {},
    warnings: [],
  };
  const generated = await readSignoffFile(generatedPath);
  if (!generated) {
    throw new Error(`generated sign-off not found: ${generatedPath}`);
  }
  return compareSignoffs(committed, generated);
}
