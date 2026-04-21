#!/usr/bin/env node
/**
 * check-no-block-chunks-in-render — enforce post-P0 block migration.
 *
 * Rule: no module outside block-UX P1 directories reads `block.outputChunks`.
 *
 * Modes:
 *   --strict    violations are errors (exit 1).
 *   (default)   violations are warnings only (exit 0). This lets the checker
 *               run on the existing tree without blocking CI until Epic δ
 *               finishes the migration.
 *
 * Allowed (never flagged, even in --strict):
 *   - packages/ui/src/entities/block/**
 *   - packages/ui/src/__tests__/p1-block-ux/**
 *   - packages/ui/src/widgets/block-card/**
 *   - packages/ui/src/widgets/block-list/**
 *   - packages/ui/src/widgets/block-filter-bar/**
 *   - any __tests__/**
 *
 * Soft-allowed (flagged as transitional; errors only in --strict):
 *   - packages/ui/src/features/block/**
 *   - packages/ui/src/features/output-search/**
 *   - packages/ui/src/features/ai-explain/**
 *   - packages/ui/src/features/secret-detect/**
 *   - packages/ui/src/features/compose/**
 *   - packages/ui/src/features/block-filter/**
 *   - packages/ui/src/features/command/**   (route-output appendBlockOutput)
 *   - packages/ui/src/widgets/composer/**   (password-prompt detection)
 *
 * Zero npm deps.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const UI_SRC = join(ROOT, 'packages/ui/src');

/** Hard-allowed paths — never reported at any level. */
function isHardAllowed(relPath) {
  const norm = relPath.split(sep).join('/');
  const parts = norm.split('/');
  if (parts.includes('__tests__')) return true;
  if (norm.startsWith('packages/ui/src/entities/block/')) return true;
  if (norm.startsWith('packages/ui/src/widgets/block-card/')) return true;
  if (norm.startsWith('packages/ui/src/widgets/block-list/')) return true;
  if (norm.startsWith('packages/ui/src/widgets/block-filter-bar/')) return true;
  // P1 block-ux tests live under __tests__ which is already caught above,
  // but be explicit for any top-level p1-block-ux directory:
  if (parts.some((seg) => seg === 'p1-block-ux')) return true;
  return false;
}

/** Soft-allowed paths — flagged as transitional (warn), only errors in --strict. */
function isSoftAllowed(relPath) {
  const norm = relPath.split(sep).join('/');
  const prefixes = [
    'packages/ui/src/features/block/',
    'packages/ui/src/features/output-search/',
    'packages/ui/src/features/ai-explain/',
    'packages/ui/src/features/secret-detect/',
    'packages/ui/src/features/compose/',
    'packages/ui/src/features/block-filter/',
    'packages/ui/src/features/command/',
    'packages/ui/src/widgets/composer/',
  ];
  return prefixes.some((p) => norm.startsWith(p));
}

/** Categorize a file relative path. */
export function classify(relPath) {
  if (isHardAllowed(relPath)) return 'allowed';
  if (isSoftAllowed(relPath)) return 'transitional';
  return 'forbidden';
}

/** Regex that matches an access / import that exposes outputChunks. */
const OUTPUT_CHUNKS_RE = /\boutputChunks\b/u;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'generated' ||
        entry.name === '.turbo'
      ) {
        continue;
      }
      yield* walk(full);
    } else if (entry.isFile()) {
      if (/\.(ts|tsx|js|mjs|cjs|jsx)$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        yield full;
      }
    }
  }
}

/** Find lines in a source file that reference outputChunks. */
export function findHits(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (OUTPUT_CHUNKS_RE.test(lines[i])) {
      out.push({ line: i + 1, raw: lines[i] });
    }
  }
  return out;
}

/** Pure audit: returns { forbidden, transitional, scanned }. */
export async function audit(root, { relBase = ROOT, classifyFn = classify } = {}) {
  const forbidden = [];
  const transitional = [];
  let scanned = 0;
  for await (const file of walk(root)) {
    scanned += 1;
    const rel = relative(relBase, file);
    const bucket = classifyFn(rel);
    if (bucket === 'allowed') continue;
    const src = await readFile(file, 'utf8');
    const hits = findHits(src);
    if (hits.length === 0) continue;
    for (const h of hits) {
      const record = { file, relPath: rel, line: h.line, raw: h.raw };
      if (bucket === 'forbidden') forbidden.push(record);
      else transitional.push(record);
    }
  }
  return { forbidden, transitional, scanned };
}

async function run() {
  const strict = process.argv.includes('--strict');

  const exists = await stat(UI_SRC).then(
    () => true,
    () => false,
  );
  if (!exists) {
    console.log(`check-no-block-chunks: info: ${relative(ROOT, UI_SRC)} missing; skipping`);
    return;
  }

  const { forbidden, transitional, scanned } = await audit(UI_SRC);

  // Both buckets warn by default; --strict upgrades both to errors. This
  // keeps the rule non-blocking on the existing codebase (per Plan 0005 P0)
  // while still surfacing the pending-migration surface area.
  const writer = strict ? console.error : console.warn;
  const levelLabel = strict ? 'ERROR' : 'warn';

  if (forbidden.length > 0) {
    writer(
      `check-no-block-chunks: ${forbidden.length} FORBIDDEN (${levelLabel}) outputChunks reference(s) — NOT on the migration allowlist:`,
    );
    for (const v of forbidden) {
      writer(`  ${v.relPath}:${v.line}: ${v.raw.trim()}`);
    }
  }
  if (transitional.length > 0) {
    writer(
      `check-no-block-chunks: ${transitional.length} TRANSITIONAL (${levelLabel}) outputChunks reference(s) — pre-approved migration surface:`,
    );
    for (const v of transitional) {
      writer(`  ${v.relPath}:${v.line}: ${v.raw.trim()}`);
    }
  }

  const hasError = strict && (forbidden.length > 0 || transitional.length > 0);
  if (hasError) {
    console.error(
      `\nPost-P0 migration: outputChunks should only live inside entities/block/** ` +
        `and the P1 block-ux widgets. Update the allowlist in ` +
        `tools/check-no-block-chunks-in-render/index.mjs if a legitimate new ` +
        `consumer has landed.`,
    );
    process.exit(1);
  }
  console.log(
    `check-no-block-chunks: ok (${scanned} file(s) scanned, ` +
      `${transitional.length} transitional warn(s), ${forbidden.length} forbidden hit(s)) ` +
      `[mode: ${strict ? 'strict' : 'warn-only'}]`,
  );
}

const invokedPath = process.argv[1] ? String(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  run().catch((err) => {
    console.error('check-no-block-chunks: fatal:', err);
    process.exit(2);
  });
}
