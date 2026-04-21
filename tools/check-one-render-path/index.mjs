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
 *   - packages/ui/src/shared/lib/ansi-parser/**       (the module owns itself)
 *   - packages/ui/src/shared/ui/ansi-output/**        (legacy span renderer;
 *     TODO(epic-delta): remove from allowlist once block UX P1 ships)
 *   - packages/ui/src/shared/lib/text/**              (plain-text projection
 *     helper — the single legitimate wrapper around `stripAnsi` for
 *     non-render consumers. Paired with Plan 0005 Epic α6 migration.)
 *   - **\/__tests__/**                                 (tests may exercise directly)
 *   - **\/p1-block-ux/**                               (P1 flag-gated work)
 *
 * In addition, a named group of files is DEFERRED — they are scheduled to
 * migrate in Plan 0005 Epic δ (block UX P1 flag gate). DEFERRED files are
 * reported as WARNINGS with exit code 0 so CI stays green; real violations
 * (any other file outside the allowlist) remain ERRORS with exit 1.
 *
 *   - packages/ui/src/widgets/block-card/**           (expanded block renderer;
 *     P1 block UX flag migration target)
 *   - packages/ui/src/widgets/compare-panel/**        (block-diff styled lines;
 *     rides the same P1 migration)
 *
 * Output per violation:
 *   <relpath>:<lineNum>: <matched line>
 *
 * Exit codes: 0 = clean OR only-deferred-warnings, 1 = forbidden violations,
 * 2 = fatal error.
 *
 * Flags:
 *   --strict  Treat DEFERRED warnings as errors too (useful for the Epic δ
 *             completion check; default behavior lets the migration ship in
 *             stages without red CI).
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

/**
 * Files that are scheduled to migrate in Epic δ (block UX P1 flag gate).
 * Their imports are WARNINGS today — once the flag lands and the renderer
 * moves, these files either go behind `p1-block-ux/` (automatically
 * allowlisted) or delete the parser import entirely.
 */
export const P1_BLOCK_UX_DEFERRED = [
  'packages/ui/src/widgets/block-card',
  'packages/ui/src/widgets/compare-panel',
];

/** True when the given repo-relative path is exempt from the rule. */
export function isAllowlisted(relPath) {
  const parts = relPath.split(sep);
  // The module itself.
  if (relPath.startsWith(join('packages/ui/src/shared/lib/ansi-parser'))) return true;
  // Legacy span renderer (removed in Epic delta).
  if (relPath.startsWith(join('packages/ui/src/shared/ui/ansi-output'))) return true;
  // Plain-text projection helper — the allowlisted wrapper around stripAnsi
  // for non-render consumers (a11y announce, AI explain, output search, copy,
  // export, compare). Added in Plan 0005 Epic α6.
  if (relPath.startsWith(join('packages/ui/src/shared/lib/text'))) return true;
  // Any __tests__ directory anywhere in the tree.
  if (parts.includes('__tests__')) return true;
  // P1 flag-gated block UX work.
  if (parts.some((seg) => seg === 'p1-block-ux')) return true;
  return false;
}

/**
 * True when `relPath` sits under a DEFERRED group. Deferred files' parser
 * imports print as WARNINGS in default mode and as ERRORS with `--strict`.
 */
export function isDeferred(relPath) {
  for (const prefix of P1_BLOCK_UX_DEFERRED) {
    if (relPath.startsWith(prefix)) return true;
  }
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
 * Pure audit: returns `{ violations, deferred, scanned }` over a root. Each
 * entry contains `{ file, relPath, line, raw }`. Deferred entries are split
 * out so callers can print them as warnings.
 *
 * `relBase` is the path used to compute repo-relative paths for the
 * allowlist test. Defaults to the repo ROOT; tests may pass their own
 * temp-dir base (so fixture files appear under a synthetic prefix).
 */
export async function audit(
  root,
  { relBase = ROOT, allowlist = isAllowlisted, deferred = isDeferred } = {},
) {
  const violations = [];
  const deferredHits = [];
  let scanned = 0;
  for await (const file of walk(root)) {
    scanned += 1;
    const rel = relative(relBase, file);
    if (allowlist(rel)) continue;
    const src = await readFile(file, 'utf8');
    const hits = findViolations(src);
    if (hits.length === 0) continue;
    const bucket = deferred(rel) ? deferredHits : violations;
    for (const h of hits) {
      bucket.push({ file, relPath: rel, line: h.line, raw: h.raw });
    }
  }
  return { violations, deferred: deferredHits, scanned };
}

async function run() {
  const strict = process.argv.includes('--strict');
  const exists = await stat(UI_SRC).then(
    () => true,
    () => false,
  );
  if (!exists) {
    console.log(`check-one-render-path: info: ${relative(ROOT, UI_SRC)} missing; skipping`);
    return;
  }
  const { violations, deferred, scanned } = await audit(UI_SRC);
  // Fatal bucket: forbidden violations OR, when --strict, deferred hits too.
  const fatal = strict ? [...violations, ...deferred] : violations;
  const warn = strict ? [] : deferred;

  if (warn.length > 0) {
    console.warn(
      `check-one-render-path: ${warn.length} deferred import(s) (P1 block UX flag migration):`,
    );
    for (const v of warn) {
      console.warn(`  warn: ${v.relPath}:${v.line}: ${v.raw.trim()}`);
    }
  }

  if (fatal.length > 0) {
    console.error(
      `check-one-render-path: ${fatal.length} violation(s) of Plan 0005 I-11 found:`,
    );
    for (const v of fatal) {
      console.error(`  ${v.relPath}:${v.line}: ${v.raw.trim()}`);
    }
    console.error(
      `\nOnly the cell renderer and __tests__ may import shared/lib/ansi-parser. ` +
        `If you are adding a legitimate new consumer, update the allowlist in ` +
        `tools/check-one-render-path/index.mjs.`,
    );
    process.exit(1);
  }

  if (warn.length > 0) {
    console.log(
      `check-one-render-path: ok with ${warn.length} deferred warning(s) ` +
        `(${scanned} file(s) scanned)`,
    );
  } else {
    console.log(`check-one-render-path: ok (${scanned} file(s) scanned)`);
  }
}

const invokedPath = process.argv[1] ? String(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  run().catch((err) => {
    console.error('check-one-render-path: fatal:', err);
    process.exit(2);
  });
}
