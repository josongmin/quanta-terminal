#!/usr/bin/env node
/**
 * Fixture tests for `tools/check-fsd-layers.mjs`.
 *
 * Builds synthetic FSD trees in a temp directory and asserts that the auditor
 * catches each forbidden import (and leaves the legitimate ones alone). Locks
 * down the rule surface so a future "helpful" refactor cannot silently start
 * passing violations.
 *
 * Run directly: `node --test tools/__tests__/check-fsd-layers.test.mjs`.
 * Intentionally no external deps — uses only Node built-ins, matching the
 * checker itself.
 */

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditLayers } from '../check-fsd-layers.mjs';

async function setup(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath);
    await mkdir(full.replace(/\/[^/]+$/u, ''), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

async function withTree(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'quanta-fsd-'));
  try {
    await setup(root, files);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('widget importing from a higher layer (pages) is flagged', async () => {
  const { violations } = await withTree(
    {
      'widgets/composer/Composer.tsx':
        "import { TerminalPage } from '../../pages/terminal-page/index.js';\nexport const x = TerminalPage;\n",
      'pages/terminal-page/index.ts': 'export const TerminalPage = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.ok(
    violations.some(
      (v) => v.category === 'layer-order' && /higher layer pages/u.test(v.rule),
    ),
    `expected layer-order violation; got ${JSON.stringify(violations)}`,
  );
});

test('forbidden host-specific import in UI is flagged', async () => {
  const { violations } = await withTree(
    {
      'widgets/terminal-shell/TerminalShell.tsx':
        "import { createTauriHostBridge } from '@quanta/host-tauri';\nexport const x = createTauriHostBridge;\n",
    },
    (root) => auditLayers(root),
  );
  assert.ok(
    violations.some(
      (v) => v.category === 'host-import' && /@quanta\/host-tauri/u.test(v.rule),
    ),
  );
});

test('features → entities is allowed (no violation)', async () => {
  const { violations, siblingExemptions } = await withTree(
    {
      'features/session/connect.ts':
        "import { useSessionStore } from '../../entities/session/index.js';\nexport const x = useSessionStore;\n",
      'entities/session/index.ts': 'export const useSessionStore = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(violations.length, 0);
  assert.equal(siblingExemptions, 0);
});

test('features importing widgets (higher) is flagged', async () => {
  const { violations } = await withTree(
    {
      'features/session/connect.ts':
        "import { TerminalShell } from '../../widgets/terminal-shell/index.js';\nexport const x = TerminalShell;\n",
      'widgets/terminal-shell/index.ts': 'export const TerminalShell = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.ok(
    violations.some(
      (v) => v.category === 'layer-order' && /features may not import from higher layer widgets/u.test(v.rule),
    ),
  );
});

test('same-layer sibling import WITHOUT FIXME is flagged as same-layer-sibling', async () => {
  const { violations } = await withTree(
    {
      'features/session/connect.ts':
        "import { runCommand } from '../command/index.js';\nexport const x = runCommand;\n",
      'features/command/index.ts': 'export const runCommand = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].category, 'same-layer-sibling');
  assert.match(violations[0].rule, /cross-slice import within "features".*session.*command/u);
});

test('same-layer sibling import WITH trailing FIXME + reason is exempted', async () => {
  const { violations, siblingExemptions } = await withTree(
    {
      'features/session/connect.ts':
        "import { runCommand } from '../command/index.js'; // FIXME(fsd-layer-skip): session delegates dispatch to command executor\nexport const x = runCommand;\n",
      'features/command/index.ts': 'export const runCommand = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(violations.length, 0);
  assert.equal(siblingExemptions, 1);
});

test('same-layer sibling import WITH FIXME on preceding line is exempted', async () => {
  const { violations, siblingExemptions } = await withTree(
    {
      'features/session/connect.ts':
        "// FIXME(fsd-layer-skip): session needs to call the command router directly\nimport { runCommand } from '../command/index.js';\nexport const x = runCommand;\n",
      'features/command/index.ts': 'export const runCommand = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(violations.length, 0);
  assert.equal(siblingExemptions, 1);
});

test('same-layer sibling import with FIXME above a multi-line import is exempted', async () => {
  const { violations, siblingExemptions } = await withTree(
    {
      'features/session/connect.ts':
        "// FIXME(fsd-layer-skip): session hands pty bytes to the command router\nimport {\n  runCommand,\n} from '../command/index.js';\nexport const x = runCommand;\n",
      'features/command/index.ts': 'export const runCommand = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(violations.length, 0, JSON.stringify(violations));
  assert.equal(siblingExemptions, 1);
});

test('same-layer sibling FIXME with too-short reason is still flagged', async () => {
  const { violations } = await withTree(
    {
      'features/session/connect.ts':
        "import { runCommand } from '../command/index.js'; // FIXME(fsd-layer-skip): tbd\nexport const x = runCommand;\n",
      'features/command/index.ts': 'export const runCommand = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].category, 'same-layer-sibling');
});

test('same-layer sibling FIXME with no reason (bare marker) is still flagged', async () => {
  const { violations } = await withTree(
    {
      'features/session/connect.ts':
        "import { runCommand } from '../command/index.js'; // FIXME(fsd-layer-skip)\nexport const x = runCommand;\n",
      'features/command/index.ts': 'export const runCommand = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].category, 'same-layer-sibling');
});

test('same-slice intra-slice import is always a no-op', async () => {
  const { violations, siblingExemptions } = await withTree(
    {
      'features/session/connect.ts':
        "import { helper } from './helper.js';\nexport const x = helper;\n",
      'features/session/helper.ts': 'export const helper = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(violations.length, 0);
  assert.equal(siblingExemptions, 0);
});

test('same-layer cross-slice inside shared is allowed (shared is exempt)', async () => {
  const { violations } = await withTree(
    {
      'shared/ui/button/Button.tsx':
        "import { cx } from '../../lib/cx.js';\nexport const x = cx;\n",
      'shared/lib/cx.ts': 'export const cx = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(violations.length, 0);
});

test('audit surfaces a scanned count and zero exemptions on a clean tree', async () => {
  const result = await withTree(
    {
      'features/session/connect.ts':
        "import { useSessionStore } from '../../entities/session/index.js';\nexport const x = useSessionStore;\n",
      'entities/session/index.ts': 'export const useSessionStore = () => null;\n',
    },
    (root) => auditLayers(root),
  );
  assert.equal(result.violations.length, 0);
  assert.equal(result.scanned, 2);
  assert.equal(result.siblingExemptions, 0);
});
