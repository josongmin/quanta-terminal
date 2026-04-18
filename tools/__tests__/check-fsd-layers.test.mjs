#!/usr/bin/env node
/**
 * Negative-test fixture for `tools/check-fsd-layers.mjs`.
 *
 * Builds synthetic FSD trees in a temp directory and asserts that the auditor
 * catches each forbidden import. This locks down the checker so a future
 * "helpful" refactor that silently starts passing violations is a hard fail.
 *
 * Run directly: `node tools/__tests__/check-fsd-layers.test.mjs`
 * Exits 0 on success, 1 on any assertion failure.
 *
 * Intentionally no external deps — uses only Node built-ins, matching the
 * checker itself.
 */

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditLayers } from '../check-fsd-layers.mjs';

async function setup(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath);
    await mkdir(full.replace(/\/[^/]+$/u, ''), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

async function run() {
  const failures = [];

  const cases = [
    {
      name: 'widget importing from a higher layer (pages) is flagged',
      files: {
        'widgets/composer/Composer.tsx':
          "import { TerminalPage } from '../../pages/terminal-page/index.js';\nexport const x = TerminalPage;\n",
        'pages/terminal-page/index.ts': 'export const TerminalPage = () => null;\n',
      },
      expect: (v) => v.some((x) => /widgets may not import from higher layer pages/u.test(x.rule)),
    },
    {
      name: 'cross-slice import within widgets is flagged',
      files: {
        'widgets/composer/Composer.tsx':
          "import { TerminalShell } from '../terminal-shell/index.js';\nexport const x = TerminalShell;\n",
        'widgets/terminal-shell/index.ts': 'export const TerminalShell = () => null;\n',
      },
      expect: (v) =>
        v.some((x) => /cross-slice import within "widgets" forbidden/u.test(x.rule)),
    },
    {
      name: 'forbidden host-specific import in UI is flagged',
      files: {
        'widgets/terminal-shell/TerminalShell.tsx':
          "import { createTauriHostBridge } from '@quanta/host-tauri';\nexport const x = createTauriHostBridge;\n",
      },
      expect: (v) =>
        v.some((x) => /@quanta\/host-tauri/u.test(x.rule) && /ADR 0014/u.test(x.rule)),
    },
    {
      name: 'features → entities is allowed (no violation)',
      files: {
        'features/session/connect.ts':
          "import { useSessionStore } from '../../entities/session/index.js';\nexport const x = useSessionStore;\n",
        'entities/session/index.ts': 'export const useSessionStore = () => null;\n',
      },
      expect: (v) => v.length === 0,
    },
    {
      name: 'features importing widgets (higher) is flagged',
      files: {
        'features/session/connect.ts':
          "import { TerminalShell } from '../../widgets/terminal-shell/index.js';\nexport const x = TerminalShell;\n",
        'widgets/terminal-shell/index.ts': 'export const TerminalShell = () => null;\n',
      },
      expect: (v) =>
        v.some((x) => /features may not import from higher layer widgets/u.test(x.rule)),
    },
    {
      name: 'FIXME(fsd-layer-skip) marker suppresses the rule',
      files: {
        'widgets/composer/Composer.tsx':
          "import { TerminalShell } from '../terminal-shell/index.js'; // FIXME(fsd-layer-skip)\nexport const x = TerminalShell;\n",
        'widgets/terminal-shell/index.ts': 'export const TerminalShell = () => null;\n',
      },
      expect: (v) => v.length === 0,
    },
  ];

  for (const tc of cases) {
    const root = await mkdtemp(join(tmpdir(), 'quanta-fsd-'));
    try {
      await setup(root, tc.files);
      const { violations } = await auditLayers(root);
      if (!tc.expect(violations)) {
        failures.push({ name: tc.name, violations });
      } else {
        console.log(`ok: ${tc.name}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    console.error('\nFAILURES:');
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    got: ${JSON.stringify(f.violations, null, 2)}`);
    }
    process.exit(1);
  }

  console.log(`\nall ${cases.length} fixture case(s) passed.`);
}

run().catch((err) => {
  console.error('fsd negative-test: fatal:', err);
  process.exit(2);
});
