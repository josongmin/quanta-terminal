#!/usr/bin/env node
/**
 * FSD layering enforcement for packages/ui/src.
 *
 * Rules enforced (per ADR 0014):
 *   - Layer order, high → low: app, processes, pages, widgets, features, entities, shared.
 *   - A module at layer N may import from strictly-lower layers (and shared); it
 *     may never import from a higher layer.
 *   - Cross-slice imports within the same non-shared layer are forbidden
 *     (e.g. `widgets/composer/` cannot import from `widgets/terminal-shell/`).
 *   - `packages/ui/` must not import from host-specific packages
 *     (@quanta/host-tauri, @quanta/host-vscode) — this preserves the
 *     ADR 0014 §Host Bridge Split contract.
 *
 * Output: one block per violation with file, line number, offending import,
 * and a clear rule string. Non-zero exit on any violation.
 *
 * Zero npm deps — Node built-ins only, so CI does not need `pnpm install`
 * to run this job.
 *
 * Escape hatch: a line may be exempted with a trailing `// FIXME(fsd-layer-skip)`
 * comment. Use sparingly; every skip is a TODO to redesign the slice.
 *
 * The audit core is exported so the rule surface can be unit-tested against
 * synthetic directory fixtures (see `tools/__tests__/check-fsd-layers.test.mjs`).
 * CLI entry is preserved and runs when the file is executed directly.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const UI_ROOT = join(ROOT, 'packages/ui/src');

// Ordered low → high so `layerRank(a) > layerRank(b)` means a is a higher
// (more composed) layer. `shared` is rank 0; `app` is the top.
export const LAYER_ORDER = ['shared', 'entities', 'features', 'widgets', 'pages', 'processes', 'app'];
export const FORBIDDEN_HOST_IMPORTS = ['@quanta/host-tauri', '@quanta/host-vscode'];

/** Walk a directory recursively and yield every .ts/.tsx path. */
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
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') {
        continue;
      }
      yield* walk(full);
    } else if (entry.isFile()) {
      if (/\.(ts|tsx)$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        yield full;
      }
    }
  }
}

/**
 * Classify an absolute file under a UI root by FSD layer + slice.
 * Returns null if the file is outside a recognized layer.
 */
export function classify(file, uiRoot) {
  const rel = relative(uiRoot, file).split(sep);
  const layer = rel[0];
  if (!LAYER_ORDER.includes(layer)) return null;
  // A slice exists only when there is a subdirectory under the layer, i.e.
  // when the path has at least three segments (layer / slice / ...file).
  // A leaf file directly at the layer root (e.g. `app/bootstrap.tsx`) has no
  // slice — it acts as a layer barrel and is allowed to compose the layer's
  // slices.
  const slice = rel.length > 2 ? rel[1] : undefined;
  return { layer, slice };
}

/**
 * Parse static `import ... from '...'` and `export ... from '...'` specifiers
 * out of a file's source. Returns [{ source, index, line, raw }].
 *
 * Regex captures both single- and double-quoted specifiers. Dynamic imports
 * are not analyzed — they are code-split boundaries that the static rule
 * does not cover by design.
 */
export function extractImports(src) {
  const out = [];
  const re = /(?:\bimport\b(?:[^'"]*?\bfrom\b)?|\bexport\b[^'"]*?\bfrom\b)\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const index = m.index;
    const lineStart = src.lastIndexOf('\n', index) + 1;
    const lineEndMaybe = src.indexOf('\n', index);
    const lineEnd = lineEndMaybe === -1 ? src.length : lineEndMaybe;
    const raw = src.slice(lineStart, lineEnd);
    // 1-based line number: count newlines up to (and not including) index.
    let line = 1;
    for (let i = 0; i < index; i += 1) {
      if (src.charCodeAt(i) === 10) line += 1;
    }
    out.push({ source: m[1], index, line, raw });
  }
  return out;
}

/**
 * Resolve an import specifier relative to the importing file:
 *   - `./`, `../` → { kind: 'fsd', layer, slice } if it lands under UI_ROOT,
 *                   otherwise { kind: 'relative-outside', path }.
 *   - bare specifier → { kind: 'package', name }.
 *
 * Note: we do not need to resolve the specifier to a concrete file on disk;
 * the layer is inferred from the path prefix alone, which is what the rule
 * cares about.
 */
export function resolveImport(fromFile, spec, uiRoot) {
  if (spec.startsWith('.')) {
    const baseDir = fromFile.replace(/\/[^/]+$/u, '');
    const abs = join(baseDir, spec);
    const loc = classify(abs, uiRoot);
    return loc ? { kind: 'fsd', ...loc } : { kind: 'relative-outside', path: abs };
  }
  if (spec.startsWith('@ui/')) {
    // Alias convention: `@ui/widgets/foo` → packages/ui/src/widgets/foo.
    const abs = join(uiRoot, spec.slice('@ui/'.length));
    const loc = classify(abs, uiRoot);
    return loc ? { kind: 'fsd', ...loc } : { kind: 'relative-outside', path: abs };
  }
  return { kind: 'package', name: spec };
}

export function layerRank(layer) {
  return LAYER_ORDER.indexOf(layer);
}

/**
 * Core audit: scan every .ts/.tsx file under `uiRoot` and return an array of
 * violations. Pure: no process.exit, no console output. CI entry layers on
 * top; tests consume this directly.
 */
export async function auditLayers(uiRoot) {
  const violations = [];
  let scanned = 0;

  for await (const file of walk(uiRoot)) {
    scanned += 1;
    const here = classify(file, uiRoot);
    if (!here) continue;
    const src = await readFile(file, 'utf8');
    const imports = extractImports(src);

    for (const imp of imports) {
      if (imp.raw.includes('FIXME(fsd-layer-skip)')) continue;

      const resolved = resolveImport(file, imp.source, uiRoot);

      if (resolved.kind === 'package') {
        if (FORBIDDEN_HOST_IMPORTS.includes(resolved.name)) {
          violations.push({
            file,
            line: imp.line,
            raw: imp.raw,
            rule: `packages/ui must not import host-specific package '${resolved.name}' (ADR 0014 host bridge split)`,
          });
        }
        continue;
      }
      if (resolved.kind !== 'fsd') continue;
      const there = resolved;

      // Rule 1: higher-layer import forbidden. `shared` imports are always OK
      // because shared has the lowest rank.
      if (layerRank(there.layer) > layerRank(here.layer)) {
        violations.push({
          file,
          line: imp.line,
          raw: imp.raw,
          rule: `${here.layer} may not import from higher layer ${there.layer} (ADR 0014)`,
        });
        continue;
      }

      // Rule 2: same-layer cross-slice forbidden (except when either side is
      // a bare layer barrel that has no slice).
      if (here.layer === there.layer && here.layer !== 'shared') {
        if (here.slice && there.slice && here.slice !== there.slice) {
          violations.push({
            file,
            line: imp.line,
            raw: imp.raw,
            rule: `cross-slice import within "${here.layer}" forbidden: ${here.slice} → ${there.slice} (ADR 0014)`,
          });
        }
      }
    }
  }

  return { violations, scanned };
}

async function run() {
  const exists = await stat(UI_ROOT).then(
    () => true,
    () => false,
  );
  if (!exists) {
    console.log(
      `check-fsd-layers: info: ${relative(ROOT, UI_ROOT)} does not exist yet; nothing to check`,
    );
    return;
  }

  const { violations, scanned } = await auditLayers(UI_ROOT);

  if (violations.length > 0) {
    console.error(`check-fsd-layers: ${violations.length} violation(s) of ADR 0014 found:\n`);
    for (const v of violations) {
      console.error(`  ${relative(ROOT, v.file)}:${v.line}`);
      console.error(`    rule:   ${v.rule}`);
      console.error(`    import: ${v.raw.trim()}\n`);
    }
    process.exit(1);
  }
  console.log(`check-fsd-layers: ok (${scanned} file(s) scanned under ${relative(ROOT, UI_ROOT)})`);
}

// Run when invoked directly via the CLI; skip when imported by tests.
const invokedPath = process.argv[1] ? String(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  run().catch((err) => {
    console.error('check-fsd-layers: fatal:', err);
    process.exit(2);
  });
}
