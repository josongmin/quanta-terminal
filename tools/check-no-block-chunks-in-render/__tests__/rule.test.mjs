#!/usr/bin/env node
/** Fixture tests for `tools/check-no-block-chunks-in-render/index.mjs`. */

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { audit, classify, findHits } from '../index.mjs';

async function withTree(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'quanta-block-chunks-'));
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

test('findHits: simple outputChunks reference is caught', () => {
  const hits = findHits('const c = block.outputChunks;\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('findHits: outputChunksFoo is also caught (word-prefix) — regex is \\b-bounded so only outputChunks itself matches', () => {
  // outputChunks is \b-bounded, so outputChunksFoo does NOT match: good.
  assert.equal(findHits('const x = outputChunksFoo;\n').length, 0);
  assert.equal(findHits('const x = outputChunks;\n').length, 1);
});

test('classify: entities/block is hard-allowed', () => {
  assert.equal(classify('packages/ui/src/entities/block/model.ts'), 'allowed');
});

test('classify: widgets/block-card is hard-allowed', () => {
  assert.equal(classify('packages/ui/src/widgets/block-card/BlockCard.tsx'), 'allowed');
});

test('classify: features/command is allowed (Epic δ: P1 block-UX slice)', () => {
  // Before Epic δ this was "transitional"; the block-UX migration promoted
  // features/command/ (route-output, boundary detector, etc.) to the hard
  // allowlist because the whole slice is P1-only.
  assert.equal(classify('packages/ui/src/features/command/route-output.ts'), 'allowed');
});

test('classify: features/output-search is allowed (Epic δ: P1 block-UX slice)', () => {
  assert.equal(classify('packages/ui/src/features/output-search/index.ts'), 'allowed');
});

test('classify: features/ai-suggest is allowed (Epic δ: P1 block-UX slice)', () => {
  assert.equal(classify('packages/ui/src/features/ai-suggest/index.ts'), 'allowed');
});

test('classify: features/history is allowed (Epic δ: P1 block-UX slice)', () => {
  assert.equal(classify('packages/ui/src/features/history/search.ts'), 'allowed');
});

test('classify: widgets/terminal-canvas is forbidden', () => {
  assert.equal(classify('packages/ui/src/widgets/terminal-canvas/Canvas.tsx'), 'forbidden');
});

test('classify: __tests__ is always allowed', () => {
  assert.equal(classify('packages/ui/src/widgets/foo/__tests__/bar.test.ts'), 'allowed');
});

test('audit: forbidden consumer is surfaced', async () => {
  const result = await withTree(
    {
      'packages/ui/src/widgets/terminal-canvas/Canvas.tsx':
        'export const x = (block) => block.outputChunks;\n',
    },
    (root) => audit(root, { relBase: root }),
  );
  assert.equal(result.forbidden.length, 1);
  assert.equal(result.transitional.length, 0);
});

test('audit: previously-transitional block-UX slice is now hard-allowed (Epic δ)', async () => {
  const result = await withTree(
    {
      'packages/ui/src/features/command/route-output.ts':
        'export const x = (block) => block.outputChunks;\n',
    },
    (root) => audit(root, { relBase: root }),
  );
  assert.equal(result.forbidden.length, 0);
  assert.equal(result.transitional.length, 0);
});

test('audit: entity owner is clean', async () => {
  const result = await withTree(
    {
      'packages/ui/src/entities/block/model.ts':
        'export const x = (block) => block.outputChunks;\n',
    },
    (root) => audit(root, { relBase: root }),
  );
  assert.equal(result.forbidden.length, 0);
  assert.equal(result.transitional.length, 0);
});
