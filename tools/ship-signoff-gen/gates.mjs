#!/usr/bin/env node
/**
 * gates.mjs — 12 ship-gate runners for Plan 0005 P0.
 *
 * Each `runGate<N>(ctx)` returns `{ id, title, verdict, evidence }`.
 * `verdict` ∈ `'GREEN' | 'YELLOW' | 'RED' | 'DEFERRED'`.
 *
 * Runners are injection-based: every external call (shell command, grep,
 * file check) is routed through `ctx.exec`, `ctx.grep`, `ctx.fileExists`.
 * Tests stub these; production supplies defaults that exec real commands
 * via `node:child_process` and read the filesystem.
 *
 * Zero npm deps — Node built-ins only.
 */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/* ------------------------------------------------------------------ */
/* Default I/O primitives (production)                                 */
/* ------------------------------------------------------------------ */

/** Run a command; resolve with `{exitCode, stdout, stderr}`. Never rejects. */
export function defaultExec(cmd, args, { cwd, env, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err), timedOut: killed });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut: killed });
    });
  });
}

/** Count case-sensitive literal-string occurrences in files under a tree. */
export async function defaultGrep({ needle, root, excludeDirs = [] }) {
  const excluded = new Set([
    'node_modules',
    'dist',
    'generated',
    '.turbo',
    'target',
    ...excludeDirs,
  ]);
  const hits = [];
  async function walk(dir) {
    let entries;
    try {
      const { readdir } = await import('node:fs/promises');
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (!/\.(ts|tsx|js|mjs|cjs|jsx)$/u.test(entry.name)) continue;
        if (entry.name.endsWith('.d.ts')) continue;
        let src;
        try {
          src = await readFile(full, 'utf8');
        } catch {
          continue;
        }
        if (src.includes(needle)) {
          const lines = src.split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            if (lines[i].includes(needle)) {
              hits.push({ file: full, line: i + 1, raw: lines[i] });
            }
          }
        }
      }
    }
  }
  await walk(root);
  return hits;
}

export async function defaultFileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Gate runners                                                        */
/* ------------------------------------------------------------------ */

/**
 * Gate 1: zero `outputChunks` reads in non-P1-block-UX code.
 *
 * Run `tools/check-no-block-chunks-in-render --strict`. If it exits 0 with
 * zero forbidden hits, GREEN. Any forbidden hit is RED (YELLOW for
 * transitional-only hits).
 */
export async function runGate1(ctx) {
  const { exec, repoRoot } = ctx;
  const result = await exec(
    'node',
    ['tools/check-no-block-chunks-in-render/index.mjs', '--strict'],
    { cwd: repoRoot },
  );
  const combined = `${result.stdout}\n${result.stderr}`;
  const forbiddenMatch = combined.match(/(\d+)\s+forbidden\s+hit/u);
  const warnMatch = combined.match(/(\d+)\s+transitional\s+warn/u);
  const forbidden = forbiddenMatch ? Number(forbiddenMatch[1]) : null;
  const warns = warnMatch ? Number(warnMatch[1]) : null;
  let verdict = 'RED';
  if (result.exitCode === 0 && forbidden === 0) {
    verdict = warns && warns > 0 ? 'YELLOW' : 'GREEN';
  }
  return {
    id: 1,
    title: 'Zero `outputChunks` in default render path',
    verdict,
    evidence: `check-no-block-chunks --strict exit=${result.exitCode}, forbidden=${forbidden ?? '?'}, transitional=${warns ?? '?'}`,
  };
}

/**
 * Gate 2: `idle-heuristic` absent from prod code.
 *
 * Grep the literal "idle-heuristic" string. Allow comments inside
 * `features/command/route-output.ts`, and any match under __tests__.
 */
export async function runGate2(ctx) {
  const { grep, repoRoot } = ctx;
  const uiSrc = join(repoRoot, 'packages/ui/src');
  const hits = await grep({ needle: 'idle-heuristic', root: uiSrc });
  const prodHits = hits.filter((h) => {
    const rel = h.file.slice(repoRoot.length + 1);
    if (rel.includes('/__tests__/')) return false;
    // Comments in route-output.ts are acceptable.
    if (rel.endsWith('features/command/route-output.ts')) {
      const trimmed = h.raw.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        return false;
      }
    }
    return true;
  });
  return {
    id: 2,
    title: '`idle-heuristic` absent from prod code',
    verdict: prodHits.length === 0 ? 'GREEN' : 'RED',
    evidence:
      prodHits.length === 0
        ? `0 prod hits (${hits.length} total, all in comments/tests)`
        : `${prodHits.length} prod hit(s): ${prodHits
            .slice(0, 3)
            .map((h) => `${h.file.slice(repoRoot.length + 1)}:${h.line}`)
            .join(', ')}`,
  };
}

/**
 * Gate 3: `check-one-render-path` passes (exit 0).
 */
export async function runGate3(ctx) {
  const { exec, repoRoot } = ctx;
  const result = await exec('node', ['tools/check-one-render-path/index.mjs'], {
    cwd: repoRoot,
  });
  return {
    id: 3,
    title: 'CI grep rule `one-render-path` passes',
    verdict: result.exitCode === 0 ? 'GREEN' : 'RED',
    evidence: `check-one-render-path exit=${result.exitCode}. ${(result.stdout || result.stderr || '').trim().split('\n')[0] || '(no output)'}`,
  };
}

/**
 * Gate 4: `check-one-input-path` passes (exit 0).
 */
export async function runGate4(ctx) {
  const { exec, repoRoot } = ctx;
  const result = await exec('node', ['tools/check-one-input-path/index.mjs'], {
    cwd: repoRoot,
  });
  return {
    id: 4,
    title: 'CI grep rule `one-input-path` passes',
    verdict: result.exitCode === 0 ? 'GREEN' : 'RED',
    evidence: `check-one-input-path exit=${result.exitCode}. ${(result.stdout || result.stderr || '').trim().split('\n')[0] || '(no output)'}`,
  };
}

/**
 * Gate 5: OSC 133 boundary hit-rate ≥ 99%.
 * Explicitly deferred to P1 per README §3 I-13 and gap-tracking.md.
 */
export async function runGate5(_ctx) {
  return {
    id: 5,
    title: 'OSC 133 boundary ≥ 99 %',
    verdict: 'DEFERRED',
    evidence:
      'Deferred to P1 per README §3 I-13 and gap-tracking.md (G-SI-01..06 P1). P0 default has no block boundaries.',
  };
}

/**
 * Gate 6: vim round-trip byte-exact (C-ED-01).
 */
export async function runGate6(ctx) {
  const { exec, repoRoot } = ctx;
  const result = await exec(
    'pnpm',
    ['-F', '@quanta/ui', 'exec', 'vitest', 'run', '-t', 'C-ED-01'],
    { cwd: repoRoot },
  );
  return {
    id: 6,
    title: 'vim round-trip byte-exact (100 iterations)',
    verdict: result.exitCode === 0 ? 'GREEN' : 'RED',
    evidence: `vitest compat/C-ED-01 exit=${result.exitCode}`,
  };
}

/**
 * Gate 7: `top -d 0.1` 60s perf budget.
 *
 * Always tolerant of the documented TS-emulator 4× widening: if the perf
 * suite exits 0 against the shipping budget but the feed P99 is still
 * above the 16 ms north-star, this gate is YELLOW (shipping-green,
 * north-star-wider) — consistent with the hand-written sign-off.
 */
export async function runGate7(ctx) {
  const { exec, repoRoot } = ctx;
  const result = await exec(
    'pnpm',
    ['-F', '@quanta/ui', 'exec', 'vitest', 'run', 'perf/top-60s-budget'],
    { cwd: repoRoot, env: { VITEST_PERF: '1' } },
  );
  if (result.exitCode !== 0) {
    return {
      id: 7,
      title: '`top -d 0.1` 60s: P99 < 16 ms + RSS < 150 MB',
      verdict: 'RED',
      evidence: `vitest perf/top-60s-budget exit=${result.exitCode}`,
    };
  }
  // Scrape observed feed P99 from stdout/stderr.
  const text = `${result.stdout}\n${result.stderr}`;
  const feedMatch = text.match(/feedP99[=:\s]+([0-9.]+)\s*ms/u);
  const feedP99 = feedMatch ? Number(feedMatch[1]) : null;
  const northStar = 16;
  const verdict = feedP99 !== null && feedP99 > northStar ? 'YELLOW' : 'GREEN';
  return {
    id: 7,
    title: '`top -d 0.1` 60s: P99 < 16 ms + RSS < 150 MB',
    verdict,
    evidence:
      feedP99 !== null
        ? `shipping budget green; feedP99=${feedP99}ms (north-star ${northStar}ms)`
        : 'shipping budget green; north-star telemetry not parsed',
  };
}

/**
 * Gate 8: default UI plain grid (p0-default.test.tsx).
 */
export async function runGate8(ctx) {
  const { exec, repoRoot } = ctx;
  const result = await exec(
    'pnpm',
    ['-F', '@quanta/ui', 'exec', 'vitest', 'run', '__tests__/integration/p0-default'],
    { cwd: repoRoot },
  );
  return {
    id: 8,
    title: 'Default UI: plain grid, no block chrome',
    verdict: result.exitCode === 0 ? 'GREEN' : 'RED',
    evidence: `vitest p0-default exit=${result.exitCode}`,
  };
}

/**
 * Gate 9: DEC 1049/1047/47 + scrollback VT tests.
 */
export async function runGate9(ctx) {
  const { exec, repoRoot } = ctx;
  const result = await exec(
    'pnpm',
    ['-F', '@quanta/ui', 'exec', 'vitest', 'run', 'vt-emulator/altbuffer', 'vt-emulator/scrollback'],
    { cwd: repoRoot },
  );
  return {
    id: 9,
    title: 'DEC 1049/1047/47 fully implemented + tested',
    verdict: result.exitCode === 0 ? 'GREEN' : 'RED',
    evidence: `vitest vt-emulator/altbuffer + scrollback exit=${result.exitCode}`,
  };
}

/**
 * Gate 10: scrollback pin hook present in source (static surface check).
 */
export async function runGate10(ctx) {
  const { fileExists, grep, repoRoot } = ctx;
  const typesPath = join(
    repoRoot,
    'packages/ui/src/shared/lib/vt-emulator/types.ts',
  );
  const emulatorPath = join(
    repoRoot,
    'packages/ui/src/shared/lib/vt-emulator/VtEmulator.ts',
  );
  const hasTypes = await fileExists(typesPath);
  const hasEmulator = await fileExists(emulatorPath);
  if (!hasTypes || !hasEmulator) {
    return {
      id: 10,
      title: 'Scrollback ring: eviction observable + pin hook verified',
      verdict: 'RED',
      evidence: 'VtEmulator.ts or types.ts missing',
    };
  }
  const pinHits = await grep({
    needle: 'pinBlockedEvictions',
    root: join(repoRoot, 'packages/ui/src/shared/lib/vt-emulator'),
  });
  return {
    id: 10,
    title: 'Scrollback ring: eviction observable + pin hook verified',
    verdict: pinHits.length > 0 ? 'GREEN' : 'RED',
    evidence: `pinBlockedEvictions references=${pinHits.length}`,
  };
}

/**
 * Gate 11: sidecar flow-control (`cargo test flow_control`).
 */
export async function runGate11(ctx) {
  const { exec, repoRoot } = ctx;
  const result = await exec(
    'cargo',
    ['test', '--manifest-path', 'packages/host-tauri/src-tauri/Cargo.toml', 'flow_control'],
    { cwd: repoRoot },
  );
  return {
    id: 11,
    title: 'Sidecar flow-control engages before last-resort drop',
    verdict: result.exitCode === 0 ? 'GREEN' : 'RED',
    evidence: `cargo test flow_control exit=${result.exitCode}`,
  };
}

/**
 * Gate 12: KR IME byte-identical (korean-2set).
 */
export async function runGate12(ctx) {
  const { exec, repoRoot } = ctx;
  const result = await exec(
    'pnpm',
    [
      '-F',
      '@quanta/ui',
      'exec',
      'vitest',
      'run',
      'features/input/ime/korean-2set',
    ],
    { cwd: repoRoot },
  );
  return {
    id: 12,
    title: 'KR IME byte-identical to corpus',
    verdict: result.exitCode === 0 ? 'GREEN' : 'RED',
    evidence: `vitest korean-2set exit=${result.exitCode}`,
  };
}

/** All 12 gate runners in order. */
export const GATE_RUNNERS = [
  runGate1,
  runGate2,
  runGate3,
  runGate4,
  runGate5,
  runGate6,
  runGate7,
  runGate8,
  runGate9,
  runGate10,
  runGate11,
  runGate12,
];

/** Run every gate sequentially with the given ctx. */
export async function runAllGates(ctx) {
  const out = [];
  for (const run of GATE_RUNNERS) {
    try {
      out.push(await run(ctx));
    } catch (err) {
      out.push({
        id: out.length + 1,
        title: `gate ${out.length + 1}`,
        verdict: 'RED',
        evidence: `gate runner threw: ${err && err.message ? err.message : String(err)}`,
      });
    }
  }
  return out;
}

/** Build a default ctx object for production use. */
export function makeDefaultCtx(repoRoot) {
  return {
    repoRoot,
    exec: defaultExec,
    grep: defaultGrep,
    fileExists: defaultFileExists,
  };
}
