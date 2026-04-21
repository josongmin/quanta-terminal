#!/usr/bin/env node
/** Fixture tests for `tools/check-one-input-path/index.mjs`. */

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditRoot,
  isAllowlisted,
  isDeferred,
  findViolations,
  P1_BLOCK_UX_DEFERRED,
} from '../index.mjs';

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

test('JSDoc continuation lines mentioning bridge.write() are NOT flagged', () => {
  const src =
    '/**\n' +
    ' * Prior to Plan 0005 α1 the race inside bridge.write() could drop\n' +
    ' * bytes. See also: `bridge.write()` pitfalls in comments below.\n' +
    ' */\n';
  const hits = findViolations(src);
  assert.equal(hits.length, 0);
});

test('line comments with bridge.write() are NOT flagged', () => {
  const src = "// historical note: bridge.write() used to race here\n";
  const hits = findViolations(src);
  assert.equal(hits.length, 0);
});

test('isAllowlisted: features/input is exempt', () => {
  assert.equal(isAllowlisted('packages/ui/src/features/input/KeyEncoder.ts'), true);
});

test('isAllowlisted: features/session/connect.ts is exempt', () => {
  assert.equal(isAllowlisted('packages/ui/src/features/session/connect.ts'), true);
});

test('isAllowlisted: features/session/write-response.ts is exempt (protocol replies)', () => {
  assert.equal(
    isAllowlisted('packages/ui/src/features/session/write-response.ts'),
    true,
  );
});

test('isAllowlisted: random widget file is NOT exempt', () => {
  assert.equal(isAllowlisted('packages/ui/src/widgets/composer/Composer.tsx'), false);
});

test('isAllowlisted: docs/*.md exempt', () => {
  assert.equal(isAllowlisted('docs/plans/foo.md'), true);
  assert.equal(isAllowlisted('README.md'), true);
});

test('isDeferred: execute.ts (P1 block UX) is deferred', () => {
  assert.equal(isDeferred('packages/ui/src/features/command/execute.ts'), true);
});

test('isDeferred: a random file is NOT deferred', () => {
  assert.equal(
    isDeferred('packages/ui/src/widgets/composer/Composer.tsx'),
    false,
  );
});

test('P1_BLOCK_UX_DEFERRED is a non-empty array', () => {
  assert.ok(Array.isArray(P1_BLOCK_UX_DEFERRED));
  assert.ok(P1_BLOCK_UX_DEFERRED.length > 0);
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
  assert.equal(result.deferred.length, 0);
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
  assert.equal(result.deferred.length, 0);
});

test('audit: DEFERRED path (execute.ts) lands in the deferred bucket, not violations', async () => {
  const result = await withTree(
    {
      'packages/ui/src/features/command/execute.ts':
        "export async function submit() {\n  await bridge.write(id, p);\n}\n",
    },
    (root) => auditRoot(root, { relBase: root }),
  );
  assert.equal(result.violations.length, 0);
  assert.equal(result.deferred.length, 1);
  assert.equal(result.deferred[0].line, 2);
  assert.equal(
    result.deferred[0].relPath,
    'packages/ui/src/features/command/execute.ts',
  );
});

test('audit: custom deferred predicate promotes a file into the deferred bucket', async () => {
  const result = await withTree(
    {
      'packages/ui/src/widgets/thing/Thing.tsx':
        "export const t = () => {\n  bridge.write(bytes);\n};\n",
    },
    (root) =>
      auditRoot(root, {
        relBase: root,
        deferred: (rel) => rel.includes('widgets/thing/'),
      }),
  );
  assert.equal(result.violations.length, 0);
  assert.equal(result.deferred.length, 1);
});

test('audit: comments inside a forbidden file are not flagged', async () => {
  const result = await withTree(
    {
      'packages/ui/src/widgets/composer/Composer.tsx':
        '/**\n * bridge.write() was historically racy.\n */\n' +
        "export const x = () => {};\n",
    },
    (root) => auditRoot(root, { relBase: root }),
  );
  assert.equal(result.violations.length, 0);
  assert.equal(result.deferred.length, 0);
});
