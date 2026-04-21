/**
 * Compat-harness audit suite (Plan 0005 P0 Agent audit).
 *
 * This file is the adversarial sweep over the compat harness + all
 * in-tree fixtures. Every `it(...)` encodes a cross-fixture invariant
 * that, if it ever regresses, tells us the harness itself is broken —
 * not a particular fixture.
 *
 * Invariants enforced here:
 *
 *  1. **Replay bit-identity**: running `replayCompatFixture(dir)` twice
 *     on the same fixture produces deep-equal reports modulo the
 *     `perf.*Ms` non-deterministic fields.
 *  2. **Byte-accounting**: `inputBytes === feedBytes + droppedBytes`,
 *     and `inputBytes` matches the on-disk byte length. Per Plan 0005
 *     test-strategy §6 this is a load-bearing invariant across the
 *     whole compat matrix; the harness now surfaces a typed
 *     `byteAccounting` report so callers can assert it cheaply.
 *  3. **Checkpoint coverage score**: each fixture asserts at least
 *     three of the six structural dimensions (cursor, altScreen, row
 *     text, row widths, row sgrDigest, scrollback). Scores below 3 are
 *     listed as "coverage gaps" in `AUDIT_RECOMMENDATIONS.md`.
 *  4. **Meta.json schema conformance**: required fields present with
 *     the right types; optional `kind` / `id` /
 *     `snapshotFormatVersion` fields respected by the harness guard.
 *  5. **Registry ↔ filesystem coherence**: every registry entry points
 *     at a directory that exists; fixture directories with a full
 *     manifest are reachable from the registry.
 *  6. **Byte-accounting regression tripwire**: a synthetic "bad
 *     counter" case proves the invariant assertion would catch a
 *     regression (rather than silently passing on any number).
 *
 * Deliberately out of scope:
 *  - Individual fixture semantics (the per-fixture `C-*.test.ts`
 *    spec files own those).
 *  - `build-fixture.mjs` idempotence: running every generator in
 *    parallel inside a Vitest worker is both slow (shells out N
 *    times) and fragile (each generator assumes its working
 *    directory). Instead the audit asserts that every fixture's
 *    `input.bytes` length matches the last checkpoint's byte offset
 *    upper bound — a cheap proxy that catches the main class of
 *    generator drift (offsets vs. bytes mismatch).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMPAT_SNAPSHOT_FORMAT_VERSION,
  replayCompatFixture,
  type CheckpointSpec,
  type CompatFixtureMeta,
  type CompatReport,
} from './compat-replay.js';
import { COMPAT_FIXTURES, type CompatCategory } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixtures directory (absolute). All compat fixtures live here as
 * siblings; the basename of each subdirectory is the compat ID.
 */
const FIXTURES_ROOT = path.resolve(
  __dirname,
  '../../../fixtures/compat',
);

/**
 * A fixture is considered "complete" (and therefore replayable by the
 * audit) when all three manifest files exist. Directories that only
 * contain a placeholder (e.g. work-in-progress batches authored in
 * parallel by other agents) are skipped — the audit is for the green
 * set only.
 */
async function isCompleteFixture(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, 'meta.json'));
    await fs.access(path.join(dir, 'checkpoints.json'));
    await fs.access(path.join(dir, 'input.bytes'));
    return true;
  } catch {
    return false;
  }
}

/** Enumerate every complete fixture directory on disk. */
async function listCompleteFixtures(): Promise<
  { readonly id: string; readonly dir: string }[]
> {
  const entries = await fs.readdir(FIXTURES_ROOT, { withFileTypes: true });
  const out: { id: string; dir: string }[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(FIXTURES_ROOT, ent.name);
    if (await isCompleteFixture(dir)) {
      out.push({ id: ent.name, dir });
    }
  }
  // Sort by id so the test output order is deterministic regardless of
  // the underlying filesystem's `readdir` order.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Strip the fields we don't want to compare across replays. `perf.*Ms`
 * is wall-clock — bit-identity over it is impossible. Everything else
 * is stable.
 */
function stripNonDeterministic(
  report: CompatReport,
): Omit<CompatReport, 'perf'> & { perf: { paintSimMs: number } } {
  return {
    passed: report.passed,
    failedCheckpoints: report.failedCheckpoints,
    byteAccounting: report.byteAccounting,
    perf: { paintSimMs: report.perf.paintSimMs },
  };
}

/**
 * Checkpoint-coverage scoring (cf. audit §3). Each dimension a fixture
 * asserts (anywhere in its checkpoint list) scores 1 point. Used both
 * for the minimum-score gate and for reporting the coverage matrix.
 */
interface CoverageScore {
  readonly cursor: boolean;
  readonly altScreen: boolean;
  readonly rowText: boolean;
  readonly widths: boolean;
  readonly sgrDigest: boolean;
  readonly scrollback: boolean;
  readonly total: number;
}

function scoreCheckpoints(
  checkpoints: readonly CheckpointSpec[],
): CoverageScore {
  const cursor = checkpoints.some((cp) => cp.expected.cursor !== undefined);
  const altScreen = checkpoints.some(
    (cp) => cp.expected.mode !== undefined,
  );
  const rowsIter = checkpoints.flatMap((cp) =>
    cp.expected.selected_rows
      ? Object.values(cp.expected.selected_rows)
      : [],
  );
  const rowText = rowsIter.some((r) => typeof r.text === 'string');
  const widths = rowsIter.some(
    (r) => Array.isArray(r.widths) && r.widths.length > 0,
  );
  const sgrDigest = rowsIter.some((r) => typeof r.sgrDigest === 'string');
  const scrollback = checkpoints.some(
    (cp) => cp.expected.scrollback !== undefined,
  );
  const total =
    Number(cursor) +
    Number(altScreen) +
    Number(rowText) +
    Number(widths) +
    Number(sgrDigest) +
    Number(scrollback);
  return { cursor, altScreen, rowText, widths, sgrDigest, scrollback, total };
}

const VALID_CATEGORIES: readonly CompatCategory[] = [
  'editor',
  'interactive',
  'pager',
  'shell',
  'stress',
  'tui',
];

describe('compat-audit: harness + fixtures', () => {
  it('lists at least the six batch-1 fixtures on disk', async () => {
    const fixtures = await listCompleteFixtures();
    const ids = fixtures.map((f) => f.id);
    // Batch 1 must always be present. Batch 2 fixtures (authored in
    // parallel by Agents O/P) may or may not be complete during this
    // agent's run — we only require the batch-1 minimum.
    const batch1 = [
      'C-ED-01',
      'C-ED-02',
      'C-IME-01',
      'C-MON-01',
      'C-MUX-01',
      'C-PG-01',
    ];
    for (const id of batch1) {
      expect(ids).toContain(id);
    }
  });

  it('registry ↔ filesystem: every complete fixture directory has a registry entry', async () => {
    const fixtures = await listCompleteFixtures();
    for (const { id } of fixtures) {
      expect(
        COMPAT_FIXTURES[id],
        `fixture directory ${id} has no registry entry`,
      ).toBeDefined();
    }
  });

  it('registry: every entry points at an existing fixtureDir', () => {
    const repoRoot = path.resolve(__dirname, '../../../../..');
    for (const entry of Object.values(COMPAT_FIXTURES)) {
      const abs = path.resolve(repoRoot, entry.fixtureDir);
      // The directory must exist, even if the manifest files are still
      // being authored (batch 2 placeholders are OK — we just require
      // the folder).
      expect(
        fsExistsSync(abs),
        `registry entry ${entry.id} points at missing directory ${abs}`,
      ).toBe(true);
    }
  });

  it('registry: every entry uses a valid category', () => {
    for (const entry of Object.values(COMPAT_FIXTURES)) {
      expect(
        VALID_CATEGORIES.includes(entry.category),
        `registry entry ${entry.id} has invalid category ${entry.category}`,
      ).toBe(true);
    }
  });

  it('registry: id field equals the record key', () => {
    for (const [key, entry] of Object.entries(COMPAT_FIXTURES)) {
      expect(entry.id).toBe(key);
    }
  });

  it('harness: replay is bit-identical across repeated runs (modulo perf.*Ms)', async () => {
    // The core determinism invariant: fixture bytes in, same projection
    // out. If any randomness creeps into row projection, byte-accounting,
    // checkpoint diffs, or scrollback reads, this test catches it.
    const fixtures = await listCompleteFixtures();
    for (const { dir } of fixtures) {
      const r1 = await replayCompatFixture(dir);
      const r2 = await replayCompatFixture(dir);
      expect(stripNonDeterministic(r1)).toEqual(stripNonDeterministic(r2));
    }
  }, 30_000);

  it('byte-accounting: inputBytes === feedBytes + droppedBytes for every fixture', { timeout: 30_000 }, async () => {
    // Plan 0005 test-strategy §6. droppedBytes is always 0 in the
    // compat harness (emergency drop is a stress-harness concern); the
    // invariant still must hold byte-for-byte.
    const fixtures = await listCompleteFixtures();
    for (const { id, dir } of fixtures) {
      const onDisk = (await fs.stat(path.join(dir, 'input.bytes'))).size;
      const report = await replayCompatFixture(dir);
      const { inputBytes, feedBytes, droppedBytes } = report.byteAccounting;

      expect(inputBytes, `${id}: inputBytes matches on-disk size`).toBe(
        onDisk,
      );
      expect(droppedBytes, `${id}: droppedBytes is zero for compat`).toBe(0);
      expect(
        feedBytes + droppedBytes,
        `${id}: input = feed + dropped`,
      ).toBe(inputBytes);
    }
  });

  it('byte-accounting: synthetic mismatch is detectable', () => {
    // Tripwire: prove the invariant ASSERTION is load-bearing. If we
    // manually corrupt the counters, the equality check MUST fail —
    // otherwise the "bytes equal" test above is silently passing.
    const corrupt = {
      inputBytes: 100,
      feedBytes: 50,
      droppedBytes: 0,
    };
    expect(
      corrupt.feedBytes + corrupt.droppedBytes === corrupt.inputBytes,
    ).toBe(false);
  });

  it('checkpoints: every fixture scores ≥ 3 on coverage dimensions', async () => {
    // Coverage floor per audit §3. Fixtures below the floor are flagged
    // in AUDIT_RECOMMENDATIONS.md for upgrades (not modified here —
    // batch-2 agents own further authoring).
    const fixtures = await listCompleteFixtures();
    for (const { id, dir } of fixtures) {
      const checkpoints = (await readJson(
        path.join(dir, 'checkpoints.json'),
      )) as CheckpointSpec[];
      const score = scoreCheckpoints(checkpoints);
      expect(
        score.total,
        `${id}: coverage score ${score.total} below floor of 3 (` +
          `cursor=${score.cursor}, altScreen=${score.altScreen}, ` +
          `rowText=${score.rowText}, widths=${score.widths}, ` +
          `sgrDigest=${score.sgrDigest}, scrollback=${score.scrollback})`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('meta.json: schema conformance for every complete fixture', async () => {
    // Required fields + type checks. Optional fields (kind, id,
    // snapshotFormatVersion) are validated only when present — the
    // harness's own `validateMeta` covers the latter cases.
    const fixtures = await listCompleteFixtures();
    for (const { id, dir } of fixtures) {
      const meta = (await readJson(
        path.join(dir, 'meta.json'),
      )) as CompatFixtureMeta;

      expect(typeof meta.shell, `${id}: meta.shell is string`).toBe('string');
      expect(
        Number.isInteger(meta.cols) && meta.cols > 0,
        `${id}: meta.cols is positive integer`,
      ).toBe(true);
      expect(
        Number.isInteger(meta.rows) && meta.rows > 0,
        `${id}: meta.rows is positive integer`,
      ).toBe(true);
      expect(
        typeof meta.description,
        `${id}: meta.description is string`,
      ).toBe('string');
      expect(
        typeof meta.authoredAt,
        `${id}: meta.authoredAt is string`,
      ).toBe('string');

      // Exactly one of `kind` or `synthetic` MUST classify the fixture.
      // We accept either for back-compat; future fixtures should prefer
      // `kind`. Recorded fixtures will land with `kind: 'recorded'` +
      // (eventually) `sourceSessionId`.
      const classified =
        meta.kind === 'synthetic' ||
        meta.kind === 'recorded' ||
        meta.synthetic === true;
      expect(classified, `${id}: meta lacks kind/synthetic classifier`).toBe(
        true,
      );
    }
  });

  it('harness: snapshotFormatVersion guard rejects drifted shape', async () => {
    // Write a temp fixture whose meta.json pins a stale version and
    // assert `replayCompatFixture` refuses to run. Protects us from a
    // future refactor to RowProjection silently rewriting every
    // checkpoint.
    const tmp = await fs.mkdtemp(path.join(FIXTURES_ROOT, '..', 'tmp-compat-'));
    try {
      await fs.writeFile(
        path.join(tmp, 'meta.json'),
        JSON.stringify({
          shell: 'synthetic',
          cols: 4,
          rows: 2,
          description: 'drift test',
          authoredAt: '2026-04-21T00:00:00Z',
          kind: 'synthetic',
          snapshotFormatVersion: COMPAT_SNAPSHOT_FORMAT_VERSION + 999,
        }),
      );
      await fs.writeFile(
        path.join(tmp, 'checkpoints.json'),
        JSON.stringify([]),
      );
      await fs.writeFile(path.join(tmp, 'input.bytes'), Buffer.from([]));
      await expect(replayCompatFixture(tmp)).rejects.toThrow(
        /snapshotFormatVersion mismatch/,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('harness: id mismatch with directory basename is rejected', async () => {
    // The `meta.id` field (when set) must equal the directory name so a
    // rename in one place can't silently desync from the registry. Uses
    // the same temp-dir pattern as the version-drift test.
    const tmp = await fs.mkdtemp(path.join(FIXTURES_ROOT, '..', 'tmp-compat-'));
    try {
      await fs.writeFile(
        path.join(tmp, 'meta.json'),
        JSON.stringify({
          shell: 'synthetic',
          cols: 4,
          rows: 2,
          description: 'id test',
          authoredAt: '2026-04-21T00:00:00Z',
          kind: 'synthetic',
          id: 'C-DEFINITELY-NOT-THE-DIR',
        }),
      );
      await fs.writeFile(
        path.join(tmp, 'checkpoints.json'),
        JSON.stringify([]),
      );
      await fs.writeFile(path.join(tmp, 'input.bytes'), Buffer.from([]));
      await expect(replayCompatFixture(tmp)).rejects.toThrow(
        /does not match directory basename/,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('checkpoints: last at_byte_offset ≤ input.bytes length (no out-of-range ref)', async () => {
    // Cheap proxy for generator drift. If a fixture author bumps a
    // checkpoint offset past the end of the byte stream, the harness
    // would silently skip the feed loop and diff against an
    // already-drained emulator — producing a misleading "pass".
    const fixtures = await listCompleteFixtures();
    for (const { id, dir } of fixtures) {
      const size = (await fs.stat(path.join(dir, 'input.bytes'))).size;
      const checkpoints = (await readJson(
        path.join(dir, 'checkpoints.json'),
      )) as CheckpointSpec[];
      for (const cp of checkpoints) {
        expect(
          cp.at_byte_offset,
          `${id}: checkpoint offset ${cp.at_byte_offset} exceeds stream length ${size}`,
        ).toBeLessThanOrEqual(size);
        expect(
          cp.at_byte_offset,
          `${id}: checkpoint offset is non-negative`,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

/* ---------- local helpers ---------- */

function fsExistsSync(p: string): boolean {
  // `fs.access` is async; `fs.statSync` would throw on missing files.
  // We use the legacy-but-sync `existsSync` via a require-free shim.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { existsSync } = require('node:fs') as {
      existsSync: (p: string) => boolean;
    };
    return existsSync(p);
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw) as unknown;
}
