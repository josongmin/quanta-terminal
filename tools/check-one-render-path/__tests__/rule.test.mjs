#!/usr/bin/env node
/**
 * Fixture tests for `tools/check-one-render-path/index.mjs`.
 *
 * Node built-ins only — no external deps.
 */

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { audit, isAllowlisted, findViolations } from '../index.mjs';

async function withTree(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'quanta-render-path-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      await mkdir(full.replace(/\/[^/]+$/u, ''), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('import of ansi-parser from widget is flagged', () => {
  const hits = findViolations(
    "import { parse } from '@ui/shared/lib/ansi-parser';\nexport const x = parse;\n",
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('relative ansi-parser import is flagged', () => {
  const hits = findViolations(
    "import { parse } from '../../shared/lib/ansi-parser/parser';\nexport const x = parse;\n",
  );
  assert.equal(hits.length, 1);
});

test('non-import mention of ansi-parser is not flagged', () => {
  const hits = findViolations(
    "// comment mentioning shared/lib/ansi-parser but not importing\nconst s = 'ansi-parser';\n",
  );
  assert.equal(hits.length, 0);
});

test('isAllowlisted: module itself is exempt', () => {
  assert.equal(isAllowlisted('packages/ui/src/shared/lib/ansi-parser/parser.ts'), true);
});

test('isAllowlisted: __tests__ anywhere is exempt', () => {
  assert.equal(isAllowlisted('packages/ui/src/widgets/foo/__tests__/bar.test.ts'), true);
});

test('isAllowlisted: random widget file is NOT exempt', () => {
  assert.equal(isAllowlisted('packages/ui/src/widgets/composer/Composer.tsx'), false);
});

test('audit: violation in widgets is caught', async () => {
  const result = await withTree(
    {
      'widgets/composer/Composer.tsx':
        "import { parse } from '../../shared/lib/ansi-parser/parser';\nexport const x = parse;\n",
    },
    (root) => audit(root, { relBase: root }),
  );
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].line, 1);
});

test('audit: __tests__ import is exempt', async () => {
  const result = await withTree(
    {
      'widgets/composer/__tests__/Composer.test.ts':
        "import { parse } from '../../../shared/lib/ansi-parser/parser';\nexport const x = parse;\n",
    },
    (root) => audit(root, { relBase: root }),
  );
  assert.equal(result.violations.length, 0);
});

test('audit: allowlisted module path is exempt', async () => {
  const result = await withTree(
    {
      'packages/ui/src/shared/lib/ansi-parser/parser.ts':
        "import { strip } from './strip';\nexport const x = strip;\n",
      'packages/ui/src/shared/lib/ansi-parser/strip.ts': 'export const strip = () => null;\n',
    },
    (root) => audit(root, { relBase: root }),
  );
  assert.equal(result.violations.length, 0);
});
