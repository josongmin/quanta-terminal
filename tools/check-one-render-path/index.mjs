#!/usr/bin/env node
/**
 * check-one-render-path — enforce Plan 0005 invariant I-11.
 *
 * Rule: no React component outside the cell renderer paints character data.
 * Concretely, no source file outside the allowlist may import from
 * `shared/lib/ansi-parser/*`. The cell renderer (and tests / the module
 * itself) are the only consumers.
 *
 * Allowlisted paths (relative to repo root):
 *   - packages/ui/src/shared/lib/ansi-parser/**      (the module owns itself)
 *   - packages/ui/src/shared/ui/ansi-output/**       (legacy span renderer;
 *     TODO(epic-delta): remove from allowlist once block UX P1 ships)
 *   - **\/__tests__/**                                (tests may exercise directly)
 *   - **\/p1-block-ux/**                              (P1 flag-gated work)
 *
 * Output per violation:
 *   <relpath>:<lineNum>: <matched line>
 *
 * Exit codes: 0 = clean, 1 = violations, 2 = fatal error.
 *
 * Zero npm deps — Node built-ins only.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const UI_SRC = join(ROOT, 'packages/ui/src');

/** Import specifier substrings that indicate a reach into the ansi-parser. */
const FORBIDDEN_SPECIFIER_PATTERNS = [
  /['"]@ui\/shared\/lib\/ansi-parser(?:\/[^'"]*)?['"]/u,
  /['"][^'"]*shared\/lib\/ansi-parser(?:\/[^'"]*)?['"]/u,
];

/** True when the given repo-relative path is exempt from the rule. */
export function isAllowlisted(relPath) {
  const parts = relPath.split(sep);
  // The module itself.
  if (relPath.startsWith(join('packages/ui/src/shared/lib/ansi-parser'))) return true;
  // Legacy span renderer (removed in Epic delta).
  if (relPath.startsWith(join('packages/ui/src/shared/ui/ansi-output'))) return true;
  // Any __tests__ directory anywhere in the tree.
  if (parts.includes('__tests__')) return true;
  // P1 flag-gated block UX work.
  if (parts.some((seg) => seg === 'p1-block-ux')) return true;
  return false;
}

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

/** Find matching ansi-parser import lines in a source string. */
export function findViolations(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/ansi-parser/u.test(line)) continue;
    // Only flag lines that look like import/export-from/require specifiers.
    if (!/(import|export|require)\b/u.test(line)) continue;
    if (FORBIDDEN_SPECIFIER_PATTERNS.some((re) => re.test(line))) {
      out.push({ line: i + 1, raw: line });
    }
  }
  return out;
}

/**
 * Pure audit: returns { violations, scanned } over a root.
 *
 * `relBase` is the path used to compute repo-relative paths for the
 * allowlist test. Defaults to the repo ROOT; tests may pass their own
 * temp-dir base (so fixture files appear under a synthetic prefix).
 */
export async function audit(root, { relBase = ROOT, allowlist = isAllowlisted } = {}) {
  const violations = [];
  let scanned = 0;
  for await (const file of walk(root)) {
    scanned += 1;
    const rel = relative(relBase, file);
    if (allowlist(rel)) continue;
    const src = await readFile(file, 'utf8');
    const hits = findViolations(src);
    for (const h of hits) {
      violations.push({ file, relPath: rel, line: h.line, raw: h.raw });
    }
  }
  return { violations, scanned };
}

async function run() {
  const exists = await stat(UI_SRC).then(
    () => true,
    () => false,
  );
  if (!exists) {
    console.log(`check-one-render-path: info: ${relative(ROOT, UI_SRC)} missing; skipping`);
    return;
  }
  const { violations, scanned } = await audit(UI_SRC);
  if (violations.length > 0) {
    console.error(
      `check-one-render-path: ${violations.length} violation(s) of Plan 0005 I-11 found:`,
    );
    for (const v of violations) {
      console.error(`  ${v.relPath}:${v.line}: ${v.raw.trim()}`);
    }
    console.error(
      `\nOnly the cell renderer and __tests__ may import shared/lib/ansi-parser. ` +
        `If you are adding a legitimate new consumer, update the allowlist in ` +
        `tools/check-one-render-path/index.mjs.`,
    );
    process.exit(1);
  }
  console.log(`check-one-render-path: ok (${scanned} file(s) scanned)`);
}

const invokedPath = process.argv[1] ? String(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  run().catch((err) => {
    console.error('check-one-render-path: fatal:', err);
    process.exit(2);
  });
}
