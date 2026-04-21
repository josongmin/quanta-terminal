#!/usr/bin/env node
/**
 * gate-check.test.mjs — per-gate unit tests using injected ctx.
 *
 * Each test stubs `ctx.exec`, `ctx.grep`, and `ctx.fileExists` so the gate
 * runner executes deterministically with no real vitest/cargo/grep work.
 *
 * Run: `node --test tools/ship-signoff-gen/__tests__/gate-check.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
  runAllGates,
} from '../gates.mjs';

/** Build a mock ctx with injected exec/grep/fileExists. */
function makeCtx({ exec, grep, fileExists } = {}) {
  return {
    repoRoot: '/tmp/mock-repo',
    exec: exec || (async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    grep: grep || (async () => []),
    fileExists: fileExists || (async () => true),
  };
}

/* ---- Gate 1 ---- */

test('Gate 1: check-no-block-chunks exits 0 with 0 forbidden → GREEN', async () => {
  const ctx = makeCtx({
    exec: async () => ({
      exitCode: 0,
      stdout: 'check: ok (100 file(s) scanned, 0 transitional warn(s), 0 forbidden hit(s))',
      stderr: '',
    }),
  });
  const res = await runGate1(ctx);
  assert.equal(res.id, 1);
  assert.equal(res.verdict, 'GREEN');
});

test('Gate 1: forbidden>0 → RED', async () => {
  const ctx = makeCtx({
    exec: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'check: 3 forbidden hit(s) found (5 transitional warn(s))',
    }),
  });
  const res = await runGate1(ctx);
  assert.equal(res.verdict, 'RED');
});

test('Gate 1: exit=0 with transitional warns → YELLOW', async () => {
  const ctx = makeCtx({
    exec: async () => ({
      exitCode: 0,
      stdout: 'ok (10 file(s) scanned, 2 transitional warn(s), 0 forbidden hit(s))',
      stderr: '',
    }),
  });
  const res = await runGate1(ctx);
  assert.equal(res.verdict, 'YELLOW');
});

/* ---- Gate 2 ---- */

test('Gate 2: all idle-heuristic hits are in __tests__ or comments → GREEN', async () => {
  const ctx = makeCtx({
    grep: async () => [
      {
        file: '/tmp/mock-repo/packages/ui/src/__tests__/foo.test.ts',
        line: 3,
        raw: 'expect(modeLabel).toBe("idle-heuristic");',
      },
      {
        file: '/tmp/mock-repo/packages/ui/src/features/command/route-output.ts',
        line: 12,
        raw: '// idle-heuristic is dead code behind flag',
      },
    ],
  });
  const res = await runGate2(ctx);
  assert.equal(res.verdict, 'GREEN');
});

test('Gate 2: idle-heuristic in prod code → RED', async () => {
  const ctx = makeCtx({
    grep: async () => [
      {
        file: '/tmp/mock-repo/packages/ui/src/features/session/engine.ts',
        line: 42,
        raw: 'const mode = "idle-heuristic";',
      },
    ],
  });
  const res = await runGate2(ctx);
  assert.equal(res.verdict, 'RED');
  assert.match(res.evidence, /1 prod hit/u);
});

/* ---- Gate 3 / 4 ---- */

test('Gate 3: check-one-render-path exit=0 → GREEN', async () => {
  const ctx = makeCtx({
    exec: async () => ({ exitCode: 0, stdout: 'ok (500 files scanned)', stderr: '' }),
  });
  const res = await runGate3(ctx);
  assert.equal(res.verdict, 'GREEN');
});

test('Gate 3: non-zero → RED', async () => {
  const ctx = makeCtx({
    exec: async () => ({ exitCode: 1, stdout: '', stderr: '3 violations' }),
  });
  const res = await runGate3(ctx);
  assert.equal(res.verdict, 'RED');
});

test('Gate 4: check-one-input-path exit=0 → GREEN', async () => {
  const ctx = makeCtx({
    exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
  });
  const res = await runGate4(ctx);
  assert.equal(res.verdict, 'GREEN');
});

/* ---- Gate 5 (deferred) ---- */

test('Gate 5: always DEFERRED regardless of ctx', async () => {
  const res = await runGate5(makeCtx());
  assert.equal(res.verdict, 'DEFERRED');
  assert.match(res.evidence, /Deferred to P1/u);
});

/* ---- Gate 6 ---- */

test('Gate 6: vim round-trip vitest exit=0 → GREEN', async () => {
  const ctx = makeCtx({
    exec: async (cmd, args) => {
      assert.ok(args.some((a) => a.includes('C-ED-01')), 'runs C-ED-01 test');
      return { exitCode: 0, stdout: '2 passed', stderr: '' };
    },
  });
  const res = await runGate6(ctx);
  assert.equal(res.verdict, 'GREEN');
});

test('Gate 6: vitest fails → RED', async () => {
  const ctx = makeCtx({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'FAIL' }) });
  const res = await runGate6(ctx);
  assert.equal(res.verdict, 'RED');
});

/* ---- Gate 7 ---- */

test('Gate 7: vitest ok + feedP99 above 16ms north-star → YELLOW', async () => {
  const ctx = makeCtx({
    exec: async () => ({
      exitCode: 0,
      stdout: 'feedP99=44.9ms renderP99=45.0ms heapDeltaMb=49.8',
      stderr: '',
    }),
  });
  const res = await runGate7(ctx);
  assert.equal(res.verdict, 'YELLOW');
  assert.match(res.evidence, /44\.9/u);
});

test('Gate 7: vitest ok + feedP99 below north-star → GREEN', async () => {
  const ctx = makeCtx({
    exec: async () => ({
      exitCode: 0,
      stdout: 'feedP99=12.3ms',
      stderr: '',
    }),
  });
  const res = await runGate7(ctx);
  assert.equal(res.verdict, 'GREEN');
});

test('Gate 7: vitest fails → RED', async () => {
  const ctx = makeCtx({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'budget exceeded' }) });
  const res = await runGate7(ctx);
  assert.equal(res.verdict, 'RED');
});

/* ---- Gate 8 ---- */

test('Gate 8: p0-default test exit=0 → GREEN', async () => {
  const ctx = makeCtx({ exec: async () => ({ exitCode: 0, stdout: '7 passed', stderr: '' }) });
  const res = await runGate8(ctx);
  assert.equal(res.verdict, 'GREEN');
});

/* ---- Gate 9 ---- */

test('Gate 9: altbuffer+scrollback passes → GREEN', async () => {
  const ctx = makeCtx({ exec: async () => ({ exitCode: 0, stdout: 'passed', stderr: '' }) });
  const res = await runGate9(ctx);
  assert.equal(res.verdict, 'GREEN');
});

/* ---- Gate 10 (static check) ---- */

test('Gate 10: pinBlockedEvictions referenced → GREEN', async () => {
  const ctx = makeCtx({
    fileExists: async () => true,
    grep: async () => [
      { file: 'x', line: 1, raw: 'const pinBlockedEvictions = 0;' },
      { file: 'y', line: 2, raw: 'this.pinBlockedEvictions++;' },
    ],
  });
  const res = await runGate10(ctx);
  assert.equal(res.verdict, 'GREEN');
});

test('Gate 10: pin hook missing → RED', async () => {
  const ctx = makeCtx({ fileExists: async () => true, grep: async () => [] });
  const res = await runGate10(ctx);
  assert.equal(res.verdict, 'RED');
});

/* ---- Gate 11 ---- */

test('Gate 11: cargo flow_control exit=0 → GREEN', async () => {
  const ctx = makeCtx({
    exec: async (cmd, args) => {
      assert.equal(cmd, 'cargo');
      assert.ok(args.includes('flow_control'));
      return { exitCode: 0, stdout: 'test result: ok. 13 passed', stderr: '' };
    },
  });
  const res = await runGate11(ctx);
  assert.equal(res.verdict, 'GREEN');
});

/* ---- Gate 12 ---- */

test('Gate 12: korean-2set vitest exit=0 → GREEN', async () => {
  const ctx = makeCtx({ exec: async () => ({ exitCode: 0, stdout: '6 passed', stderr: '' }) });
  const res = await runGate12(ctx);
  assert.equal(res.verdict, 'GREEN');
});

/* ---- runAllGates orchestration ---- */

test('runAllGates: runs all 12 gates in order', async () => {
  const ctx = makeCtx({
    exec: async () => ({
      exitCode: 0,
      stdout: 'ok feedP99=10ms (0 transitional warn(s), 0 forbidden hit(s))',
      stderr: '',
    }),
    grep: async ({ needle }) => {
      if (needle === 'pinBlockedEvictions') {
        return [{ file: 'x', line: 1, raw: 'pinBlockedEvictions' }];
      }
      return [];
    },
    fileExists: async () => true,
  });
  const out = await runAllGates(ctx);
  assert.equal(out.length, 12);
  assert.deepEqual(
    out.map((g) => g.id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  // gate 5 is always DEFERRED
  assert.equal(out[4].verdict, 'DEFERRED');
  // every non-deferred gate should be GREEN in this happy-path ctx
  const nonDeferred = out.filter((g) => g.verdict !== 'DEFERRED');
  const greens = nonDeferred.filter((g) => g.verdict === 'GREEN').length;
  assert.equal(greens, 11, `expected 11 GREEN; got ${JSON.stringify(out.map((g) => [g.id, g.verdict]))}`);
});

test('runAllGates: one throwing runner does not stop the loop', async () => {
  const ctx = makeCtx({
    exec: async (cmd, args) => {
      // Fail the cargo call specifically
      if (cmd === 'cargo') throw new Error('cargo not installed');
      return { exitCode: 0, stdout: 'feedP99=10ms', stderr: '' };
    },
    grep: async ({ needle }) => {
      if (needle === 'pinBlockedEvictions') {
        return [{ file: 'x', line: 1, raw: 'pinBlockedEvictions' }];
      }
      return [];
    },
    fileExists: async () => true,
  });
  const out = await runAllGates(ctx);
  assert.equal(out.length, 12);
  // Gate 11 (cargo flow_control) should be RED with a thrown-error evidence.
  assert.equal(out[10].verdict, 'RED');
});
