#!/usr/bin/env node
/** Fixture tests for `tools/check-one-input-path/index.mjs`. */

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRoot, isAllowlisted, findViolations } from '../index.mjs';

async function withTree(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'quanta-input-path-'));
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

test('bridge.write( is flagged', () => {
  const hits = findViolations("  bridge.write(bytes);\n");
  assert.equal(hits.length, 1);
});

test('connection.write( is flagged', () => {
  const hits = findViolations("await connection.write(encoded);\n");
  assert.equal(hits.length, 1);
});

test('sessionConnection.write( and connectedSession.write( are flagged', () => {
  const hits = findViolations("sessionConnection.write(x);\nconnectedSession.write(y);\n");
  assert.equal(hits.length, 2);
});

test('foo.write( on an unrelated object is NOT flagged', () => {
  const hits = findViolations("fs.write(fd, buf);\nstream.write('hi');\n");
  assert.equal(hits.length, 0);
});

test('isAllowlisted: features/input is exempt', () => {
  assert.equal(isAllowlisted('packages/ui/src/features/input/KeyEncoder.ts'), true);
});

test('isAllowlisted: features/session/connect.ts is exempt', () => {
  assert.equal(isAllowlisted('packages/ui/src/features/session/connect.ts'), true);
});

test('isAllowlisted: random widget file is NOT exempt', () => {
  assert.equal(isAllowlisted('packages/ui/src/widgets/composer/Composer.tsx'), false);
});

test('isAllowlisted: docs/*.md exempt', () => {
  assert.equal(isAllowlisted('docs/plans/foo.md'), true);
  assert.equal(isAllowlisted('README.md'), true);
});

test('audit: disallowed widget write is caught', async () => {
  const result = await withTree(
    {
      'packages/ui/src/widgets/composer/Composer.tsx':
        "export const x = () => {\n  bridge.write(bytes);\n};\n",
    },
    (root) => auditRoot(root, { relBase: root }),
  );
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].line, 2);
});

test('audit: features/input write is allowed', async () => {
  const result = await withTree(
    {
      'packages/ui/src/features/input/sink.ts':
        "export const sink = () => {\n  bridge.write(bytes);\n};\n",
    },
    (root) => auditRoot(root, { relBase: root }),
  );
  assert.equal(result.violations.length, 0);
});
