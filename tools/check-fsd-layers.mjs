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
 * Same-layer sibling escape hatch — enforcement intent:
 *   For the `entities` / `features` / `widgets` layers, a sibling-slice import
 *   is permitted ONLY when the import line (or the line immediately above it)
 *   carries `FIXME(fsd-layer-skip): <reason>` with a meaningful reason
 *   (>=10 non-whitespace chars). Every such exemption is a future redesign
 *   debt entry; we require the reason inline so audit `rg` finds it.
 *
 * Output: one line per violation, prefixed with `[layer-order]`,
 * `[same-layer-sibling]`, or `[host-import]`. Non-zero exit on any violation.
 *
 * Zero npm deps — Node built-ins only, so CI does not need `pnpm install`
 * to run this job.
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

/** Layers where the same-layer sibling rule applies. `shared` is exempt by
 *  design (internal segments like `lib`/`ui` need to compose); other layers
 *  above `widgets` are either single-slice (`app`) or not in use yet. */
export const SIBLING_RULE_LAYERS = new Set(['entities', 'features', 'widgets']);

/** Minimum non-whitespace chars required in the reason after `FIXME(fsd-layer-skip):`. */
export const SIBLING_FIXME_MIN_REASON_CHARS = 10;

const SIBLING_FIXME_RE = /FIXME\(fsd-layer-skip\)\s*:\s*(.*)$/u;

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
 * out of a file's source. Returns [{ source, index, line, raw, prevLine }].
 *
 * `raw` is the single line containing the matched specifier; `prevLine` is the
 * line above it (empty string if the match is on line 1). Both trimmed of
 * trailing newlines. The preceding-line capture is what powers the
 * "FIXME on the line immediately above the import" escape hatch, which is
 * required because multi-line imports push the specifier onto a line that
 * cannot also hold a trailing comment.
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
    // `m.index` points at the statement keyword (`import` / `export`). The
    // specifier quote is at `specIdx` — for a multi-line import these live on
    // different source lines.
    const keywordIdx = m.index;
    const specIdx = m.index + m[0].lastIndexOf(m[1]);

    const specLineStart = src.lastIndexOf('\n', specIdx - 1) + 1;
    const specLineEndMaybe = src.indexOf('\n', specIdx);
    const specLineEnd = specLineEndMaybe === -1 ? src.length : specLineEndMaybe;
    const raw = src.slice(specLineStart, specLineEnd);

    const keywordLineStart = src.lastIndexOf('\n', keywordIdx - 1) + 1;
    const keywordLineEndMaybe = src.indexOf('\n', keywordIdx);
    const keywordLineEnd = keywordLineEndMaybe === -1 ? src.length : keywordLineEndMaybe;
    const keywordLineRaw = src.slice(keywordLineStart, keywordLineEnd);

    // Line immediately preceding the statement keyword — where a top-comment
    // FIXME would naturally live. Empty string if the statement starts at the
    // top of the file.
    const prevLineEnd = keywordLineStart - 1;
    const prevLineStart = prevLineEnd > 0 ? src.lastIndexOf('\n', prevLineEnd - 1) + 1 : 0;
    const prevLine = prevLineEnd > 0 ? src.slice(prevLineStart, prevLineEnd) : '';

    // 1-based line number of the specifier.
    let line = 1;
    for (let i = 0; i < specIdx; i += 1) {
      if (src.charCodeAt(i) === 10) line += 1;
    }
    out.push({ source: m[1], index: specIdx, line, raw, keywordLineRaw, prevLine });
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
 * Pull a reason out of `FIXME(fsd-layer-skip): <reason>` on one of the
 * candidate comment lines. Returns the reason string or null if no valid
 * FIXME is present. A reason is valid when it contains at least
 * `SIBLING_FIXME_MIN_REASON_CHARS` non-whitespace characters.
 */
export function extractSiblingFixmeReason(lines) {
  for (const line of lines) {
    const m = line.match(SIBLING_FIXME_RE);
    if (!m) continue;
    const reason = m[1].trim();
    const nonWs = reason.replace(/\s+/gu, '');
    if (nonWs.length >= SIBLING_FIXME_MIN_REASON_CHARS) return reason;
  }
  return null;
}

/**
 * Core audit: scan every .ts/.tsx file under `uiRoot` and return
 * { violations, scanned, siblingExemptions }. Pure: no process.exit, no
 * console output. CI entry layers on top; tests consume this directly.
 */
export async function auditLayers(uiRoot) {
  const violations = [];
  let scanned = 0;
  let siblingExemptions = 0;

  for await (const file of walk(uiRoot)) {
    scanned += 1;
    const here = classify(file, uiRoot);
    if (!here) continue;
    const src = await readFile(file, 'utf8');
    const imports = extractImports(src);

    for (const imp of imports) {
      const commentLines = [imp.raw, imp.keywordLineRaw, imp.prevLine];
      const hasLegacyFixme = commentLines.some((l) => l.includes('FIXME(fsd-layer-skip)'));

      const resolved = resolveImport(file, imp.source, uiRoot);

      if (resolved.kind === 'package') {
        if (FORBIDDEN_HOST_IMPORTS.includes(resolved.name)) {
          if (hasLegacyFixme) continue;
          violations.push({
            category: 'host-import',
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
      // because shared has the lowest rank. Legacy FIXME marker suppresses.
      if (layerRank(there.layer) > layerRank(here.layer)) {
        if (hasLegacyFixme) continue;
        violations.push({
          category: 'layer-order',
          file,
          line: imp.line,
          raw: imp.raw,
          rule: `${here.layer} may not import from higher layer ${there.layer} (ADR 0014)`,
        });
        continue;
      }

      // Rule 2: same-layer cross-slice forbidden inside entities / features /
      // widgets. The escape hatch requires `FIXME(fsd-layer-skip): <reason>`
      // on the import line, the statement-keyword line, or the line above.
      if (
        here.layer === there.layer &&
        SIBLING_RULE_LAYERS.has(here.layer) &&
        here.slice &&
        there.slice &&
        here.slice !== there.slice
      ) {
        const reason = extractSiblingFixmeReason(commentLines);
        if (reason) {
          siblingExemptions += 1;
          continue;
        }
        violations.push({
          category: 'same-layer-sibling',
          file,
          line: imp.line,
          raw: imp.raw,
          rule:
            `cross-slice import within "${here.layer}" forbidden: ${here.slice} → ${there.slice}; ` +
            `allow by adding \`// FIXME(fsd-layer-skip): <reason>\` on the import or preceding line ` +
            `(reason must have >=${SIBLING_FIXME_MIN_REASON_CHARS} non-whitespace chars)`,
        });
      }
    }
  }

  return { violations, scanned, siblingExemptions };
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

  const { violations, scanned, siblingExemptions } = await auditLayers(UI_ROOT);

  if (violations.length > 0) {
    console.error(`check-fsd-layers: ${violations.length} violation(s) of ADR 0014 found:`);
    for (const v of violations) {
      console.error(
        `  [${v.category}] ${relative(ROOT, v.file)}:${v.line}: ${v.rule} — ${v.raw.trim()}`,
      );
    }
    process.exit(1);
  }
  console.log(
    `check-fsd-layers: ok (${scanned} file(s) scanned, ${siblingExemptions} same-layer exemption(s) acknowledged)`,
  );
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
