#!/usr/bin/env node
/**
 * ship-signoff-gen — Plan 0005 P1-I entry point.
 *
 * Runs all 12 P0 gate checks and writes `artifacts/ship-signoff/<date>.md`
 * in the same format as the hand-written
 * `docs/plans/0005-sota-convergence/SHIP_SIGNOFF.md`.
 *
 * Flags:
 *   --out <path>        override default output path
 *   --commit <sha>      embed a commit sha in the header (default: git HEAD)
 *   --print             print the generated markdown to stdout
 *   --table             print only the table (for `pnpm check:signoff`)
 *   --no-write          do not write the artifact file (useful for CI preview)
 *   --compare <path>    after generating, diff against this committed file
 *                       (exits non-zero on alerting regression when
 *                       combined with --fail-on-drift)
 *   --fail-on-drift     exit 1 if `--compare` finds regressions
 *
 * Zero npm deps — Node built-ins only.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDefaultCtx, runAllGates, defaultExec } from './gates.mjs';
import { formatDate, formatSignoff } from './format.mjs';
import {
  compareSignoffs,
  formatDriftReport,
  parseSignoff,
  readSignoffFile,
} from './compare.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function parseArgs(argv) {
  const out = {
    out: null,
    commit: null,
    print: false,
    table: false,
    noWrite: false,
    compare: null,
    failOnDrift: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') {
      out.out = argv[++i];
    } else if (a === '--commit') {
      out.commit = argv[++i];
    } else if (a === '--print') {
      out.print = true;
    } else if (a === '--table') {
      out.table = true;
    } else if (a === '--no-write') {
      out.noWrite = true;
    } else if (a === '--compare') {
      out.compare = argv[++i];
    } else if (a === '--fail-on-drift') {
      out.failOnDrift = true;
    }
  }
  return out;
}

async function currentCommit() {
  const result = await defaultExec('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/** Tabular stdout summary for engineer pre-PR checks. */
export function renderTable(gates) {
  const widths = {
    id: 2,
    verdict: 8,
    title: Math.max(20, ...gates.map((g) => g.title.length)),
  };
  const lines = [];
  lines.push(
    `${pad('#', widths.id)}  ${pad('Verdict', widths.verdict)}  ${pad('Title', widths.title)}`,
  );
  lines.push(
    `${'-'.repeat(widths.id)}  ${'-'.repeat(widths.verdict)}  ${'-'.repeat(widths.title)}`,
  );
  for (const g of gates) {
    lines.push(
      `${pad(String(g.id), widths.id)}  ${pad(g.verdict, widths.verdict)}  ${pad(g.title, widths.title)}`,
    );
  }
  return lines.join('\n');
}

function pad(s, n) {
  return String(s).padEnd(n, ' ');
}

async function main(argv) {
  const args = parseArgs(argv);
  const ctx = makeDefaultCtx(ROOT);
  const gates = await runAllGates(ctx);
  const date = formatDate();
  const commit = args.commit || (await currentCommit()) || 'unknown';
  const md = formatSignoff(gates, { date, commit, auditor: 'ship-signoff-gen (automated)' });

  if (!args.noWrite) {
    const outPath =
      args.out || join(ROOT, 'artifacts/ship-signoff', `${date}.md`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, md, 'utf8');
    if (!args.table && !args.print) {
      console.error(`ship-signoff-gen: wrote ${outPath}`);
    }
  }

  if (args.print) {
    process.stdout.write(md);
  }
  if (args.table) {
    console.log(renderTable(gates));
  }

  if (args.compare) {
    const committed = (await readSignoffFile(args.compare)) || {
      gates: {},
      warnings: [],
    };
    const generated = parseSignoff(md);
    const diff = compareSignoffs(committed, generated);
    const report = formatDriftReport(diff, { date });
    console.log('\n' + report);
    if (args.failOnDrift && diff.alertCount > 0) {
      process.exit(1);
    }
  }
}

const invokedPath = process.argv[1] ? String(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('ship-signoff-gen: fatal:', err);
    process.exit(2);
  });
}

export { main, parseArgs };
