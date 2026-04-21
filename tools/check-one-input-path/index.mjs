#!/usr/bin/env node
/**
 * check-one-input-path — enforce Plan 0005 invariant I-12.
 *
 * Rule: only `features/input/` and the single session input surface may
 * write to the PTY bridge. Anywhere else, a `bridge.write(`,
 * `connection.write(`, `sessionConnection.write(`, or
 * `connectedSession.write(` call is a violation.
 *
 * Allowed callers (relative to repo root):
 *   - packages/ui/src/features/input/**
 *   - packages/ui/src/features/session/SessionInputSurface.tsx  (future)
 *   - packages/ui/src/features/session/connect.ts               (the sink wrapper)
 *   - packages/ui/src/features/tui/TuiInputSurface.tsx          (legacy; TODO(epic-beta): remove)
 *   - packages/ui/src/features/session-tabs/**                   (session-connection wrapper)
 *   - any `__tests__/**`, `fixtures/**`, `tools/**`, `docs/**`, `*.md`
 *
 * Zero npm deps — Node built-ins only.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCAN_ROOTS = [
  join(ROOT, 'packages/ui/src'),
  join(ROOT, 'packages/host-common/src'),
  join(ROOT, 'packages/host-tauri/src'),
];

/** Identifier prefixes that, when followed by `.write(`, indicate a PTY sink. */
const WRITE_PATTERNS = [
  /\bbridge\.write\s*\(/u,
  /\bconnection\.write\s*\(/u,
  /\bsessionConnection\.write\s*\(/u,
  /\bconnectedSession\.write\s*\(/u,
];

/** True when the given repo-relative path may legally call the sinks. */
export function isAllowlisted(relPath) {
  // Normalize to forward-slashes so the string checks below work on Windows too.
  const norm = relPath.split(sep).join('/');
  const parts = norm.split('/');

  if (parts.includes('__tests__')) return true;
  if (parts.includes('fixtures')) return true;
  if (parts[0] === 'tools' || parts[0] === 'docs') return true;
  if (norm.endsWith('.md')) return true;

  if (norm.startsWith('packages/ui/src/features/input/')) return true;
  if (norm === 'packages/ui/src/features/session/SessionInputSurface.tsx') return true;
  if (norm === 'packages/ui/src/features/session/connect.ts') return true;
  if (norm === 'packages/ui/src/features/tui/TuiInputSurface.tsx') return true;
  if (norm.startsWith('packages/ui/src/features/session-tabs/')) return true;

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
        entry.name === '.turbo' ||
        entry.name === 'target'
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

/** Find matching `.write(` call lines in source. */
export function findViolations(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/\.write\s*\(/u.test(line)) continue;
    if (WRITE_PATTERNS.some((re) => re.test(line))) {
      out.push({ line: i + 1, raw: line });
    }
  }
  return out;
}

/** Pure audit over one root. */
export async function auditRoot(root, { relBase = ROOT, allowlist = isAllowlisted } = {}) {
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
  let totalScanned = 0;
  const allViolations = [];
  for (const root of SCAN_ROOTS) {
    const exists = await stat(root).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    const { violations, scanned } = await auditRoot(root);
    totalScanned += scanned;
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    console.error(
      `check-one-input-path: ${allViolations.length} violation(s) of Plan 0005 I-12 found:`,
    );
    for (const v of allViolations) {
      console.error(`  ${v.relPath}:${v.line}: ${v.raw.trim()}`);
    }
    console.error(
      `\nOnly features/input/** and the session input surface may write to the PTY bridge. ` +
        `If you are wiring a new input producer, route it through the input pipeline. ` +
        `If this is a legitimate new wrapper, update the allowlist in ` +
        `tools/check-one-input-path/index.mjs.`,
    );
    process.exit(1);
  }
  console.log(`check-one-input-path: ok (${totalScanned} file(s) scanned)`);
}

const invokedPath = process.argv[1] ? String(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  run().catch((err) => {
    console.error('check-one-input-path: fatal:', err);
    process.exit(2);
  });
}
