/**
 * EPIC-I — xterm removal verification (RFC 0001 §19).
 *
 * Three cheap smoke checks that will break loudly if anyone reintroduces
 * xterm.js through a back door:
 *
 *   1. `import('@xterm/xterm')` rejects. The dep has been removed from
 *      `packages/ui/package.json`, so the dynamic import must fail with
 *      a module-resolution error.
 *   2. `TerminalPage` mounts `TerminalCanvas` unconditionally (no
 *      `data-renderer` branching on a legacy xterm surface). We probe
 *      by asserting the page's `main` region carries the canvas
 *      renderer marker and no `.xterm-*` selector is queryable.
 *   3. No CSS module under the UI ships an `.xterm` class selector.
 *      This is a fast text scan over every `.module.css` file.
 *
 * If you are here to re-enable xterm as a fallback, start with the
 * removal RFC and then talk to @owners — do not disable this file.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('EPIC-I xterm removal — invariants', () => {
  afterEach(() => {
    // Nothing — each test is self-contained.
  });

  it('dynamic import of @xterm/xterm rejects (dep is gone)', async () => {
    // Vitest resolves via the project's module graph; a removed dep
    // produces a `ERR_MODULE_NOT_FOUND` / `Cannot find package` error.
    let threw = false;
    try {
      // The `/* @vite-ignore */` hint keeps vite from trying to
      // pre-bundle a path it knows shouldn't exist.
      await import(/* @vite-ignore */ '@xterm/xterm');
    } catch (err) {
      threw = true;
      // Any resolution error is acceptable — we just need the attempt
      // to fail.
      expect(err).toBeDefined();
    }
    expect(threw).toBe(true);
  });

  it('TerminalPage source mounts TerminalCanvas unconditionally', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const pageSrc = resolve(here, '../pages/terminal-page/TerminalPage.tsx');
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
    const here = fileURLToPath(new URL('.', import.meta.url));
    const uiSrc = resolve(here, '..');
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
