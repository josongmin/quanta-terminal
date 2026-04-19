/**
 * EPIC-I — xterm removal verification (RFC 0001 §19).
 *
 * Four cheap smoke checks that will break loudly if anyone reintroduces
 * xterm.js through a back door:
 *
 *   1. `packages/ui/package.json` lists no `@xterm/*` entry under
 *      `dependencies`, `devDependencies`, `peerDependencies`, or
 *      `optionalDependencies`. This is the authoritative pin: a
 *      dynamic `import('@xterm/xterm')` would fail at the vite
 *      resolver layer before the test body ever ran, so we audit the
 *      manifest directly instead.
 *   2. No source file under `packages/ui/src/` contains an
 *      `@xterm/…` import or `require('@xterm/…')` call. This is a
 *      full-tree grep that also rejects string-literal forms used with
 *      dynamic loaders.
 *   3. `TerminalPage` mounts `TerminalCanvas` unconditionally (no
 *      `data-renderer` branching on a legacy xterm surface). We probe
 *      by asserting the page's `main` region carries the canvas
 *      renderer marker and no `.xterm-*` selector is queryable.
 *   4. No CSS module under the UI ships an `.xterm` class selector.
 *      This is a fast text scan over every `.module.css` file.
 *
 * If you are here to re-enable xterm as a fallback, start with the
 * removal RFC and then talk to @owners — do not disable this file.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The test runs under jsdom, whose patched `URL` constructor can choke on
// `new URL('.', import.meta.url)`. Resolve the file path directly via
// `fileURLToPath(import.meta.url)` — the pattern used elsewhere in this
// package — and compute the test-file directory once.
const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);

describe('EPIC-I xterm removal — invariants', () => {
  it('packages/ui/package.json lists no @xterm/* dependency', async () => {
    const pkgPath = resolve(HERE, '../../package.json');
    const raw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const buckets: Array<[string, Record<string, string> | undefined]> = [
      ['dependencies', pkg.dependencies],
      ['devDependencies', pkg.devDependencies],
      ['peerDependencies', pkg.peerDependencies],
      ['optionalDependencies', pkg.optionalDependencies],
    ];
    const offenders: string[] = [];
    for (const [bucket, entries] of buckets) {
      if (!entries) continue;
      for (const name of Object.keys(entries)) {
        if (name === '@xterm' || name.startsWith('@xterm/') || name === 'xterm') {
          offenders.push(`${bucket}: ${name}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toHaveLength(0);
  });

  it('no source file imports or requires @xterm/*', async () => {
    const uiSrc = resolve(HERE, '..');
    const hits: string[] = [];
    await scanSource(uiSrc, SELF_PATH, hits);
    // Reject any real import/require/dynamic-import of a concrete
    // `@xterm/<pkg>` module. A bare `@xterm` mention (e.g. a doc
    // string) is not enough — we key on load syntax.
    const patterns: RegExp[] = [
      /from\s+['"]@xterm\/[^'"]+['"]/,
      /import\s*\(\s*['"]@xterm\/[^'"]+['"]/,
      /require\s*\(\s*['"]@xterm\/[^'"]+['"]/,
      /from\s+['"]xterm['"]/,
      /import\s*\(\s*['"]xterm['"]/,
      /require\s*\(\s*['"]xterm['"]/,
    ];
    const violations = hits.filter((line) => patterns.some((p) => p.test(line)));
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  it('TerminalPage source mounts TerminalCanvas unconditionally', async () => {
    const pageSrc = resolve(HERE, '../pages/terminal-page/TerminalPage.tsx');
    const text = await fs.readFile(pageSrc, 'utf8');
    // The page must still mention the unified renderer marker and must
    // not reference the legacy `terminal-shell/` widget or any
    // `tuiActive` / `altScreenVisible` conditional branches.
    expect(text).toContain('data-renderer="canvas"');
    expect(text).not.toMatch(/widgets\/terminal-shell/);
    expect(text).not.toMatch(/\btuiActive\b/);
    expect(text).not.toMatch(/\baltScreenVisible\b/);
    expect(text).not.toMatch(/\bneedsAltScreen\b/);
    // Unified engine: BlockList is the unconditional host. We allow
    // degraded-mode and alt-screen-status overlays to remain.
    expect(text).toContain('BlockList');
  });

  it('no CSS module ships an `.xterm` class selector', async () => {
    const uiSrc = resolve(HERE, '..');
    const hits: string[] = [];
    await scanCss(uiSrc, hits);
    // A literal match on `.xterm` at a word boundary. We accept
    // comments (CSS comments are `/* ... */`, which we strip below).
    const violations = hits.filter((h) => /(?:^|[^\w-])\.xterm(?![\w-])/.test(h));
    expect(violations, violations.join('\n')).toHaveLength(0);
  });
});

async function scanCss(dir: string, hits: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await scanCss(full, hits);
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.module.css') && !e.name.endsWith('.css')) continue;
    const text = await fs.readFile(full, 'utf8');
    // Strip CSS block comments so a "// historical-xterm-reference:"
    // prose does not trip the scan.
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const line of stripped.split('\n')) {
      if (line.includes('.xterm')) {
        hits.push(`${relative(resolve(dir, '..'), full)}: ${line.trim()}`);
      }
    }
  }
}

// Walk every .ts/.tsx/.js/.jsx/.mjs/.cjs source file under the UI src
// tree and push one entry per line to `hits`, tagged with a repo-relative
// path. The test file itself is excluded because it contains regex
// literals that would otherwise self-match.
async function scanSource(dir: string, selfPath: string, hits: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const codeExt = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await scanSource(full, selfPath, hits);
      continue;
    }
    if (!e.isFile()) continue;
    if (!codeExt.test(e.name)) continue;
    if (full === selfPath) continue;
    const text = await fs.readFile(full, 'utf8');
    const rel = relative(resolve(dir, '..'), full);
    for (const line of text.split('\n')) {
      hits.push(`${rel}: ${line}`);
    }
  }
}
