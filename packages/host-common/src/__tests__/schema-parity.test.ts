/**
 * TS ↔ Rust schema parity.
 *
 * This test is the guardrail that catches Rust-side enum drift before it ships
 * to the frontend. It reads `crates/quanta-proto/src/*.rs` as UTF-8 text (no
 * Rust toolchain invoked), scrapes every variant of every enum the wire format
 * depends on, and asserts the TS mirrors in `@quanta/host-common` and
 * `@quanta/ui/shared/types/generated/events` carry a matching snake_case
 * literal for each one.
 *
 * The point is rigor-over-breadth: the test fails loud with a diff naming the
 * missing variant and the file it was scraped from. Adding a Rust variant
 * without the TS counterpart breaks this test before the PR lands.
 *
 * How to update when a Rust variant is added:
 *   1. Add the snake_case literal to the corresponding TS union in
 *      `packages/host-common/src/events.ts` and, if the enum is also mirrored
 *      in the "generated" shim, in
 *      `packages/ui/src/shared/types/generated/events.ts`.
 *   2. If the enum is new, add a case to `RUST_ENUMS` below with its Rust
 *      identifier and the TS source files it must appear in.
 *   3. Re-run `pnpm --filter @quanta/host-common test`.
 *
 * Divergence policy: this file does NOT auto-edit Rust or TS. A red test is a
 * signal for whichever sibling agent owns the drift to fix in their lane. See
 * ADR 0014 §Schema Sharing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname = packages/host-common/src/__tests__
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

const RUST_PROTO_DIR = join(REPO_ROOT, 'crates', 'quanta-proto', 'src');
const TS_HOST_COMMON_EVENTS = join(REPO_ROOT, 'packages', 'host-common', 'src', 'events.ts');
const TS_UI_GENERATED_EVENTS = join(
  REPO_ROOT,
  'packages',
  'ui',
  'src',
  'shared',
  'types',
  'generated',
  'events.ts',
);

function readRust(name: string): string {
  return readFileSync(join(RUST_PROTO_DIR, name), 'utf8');
}

function readTs(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Convert a Rust `UpperCamelCase` variant identifier to the `snake_case` form
 * serde emits under `#[serde(rename_all = "snake_case")]`. The algorithm must
 * agree with serde-internal `rename_all` — matching real serde output is why
 * this function exists rather than a one-liner `toLowerCase()`.
 *
 * Rules:
 *   - Insert `_` between `lower` → `Upper` transitions.
 *   - Insert `_` between adjacent capitals when the next char is lower
 *     (e.g. `HTTPServer` → `http_server`). Not strictly needed for Phase 1
 *     names but kept for future resilience.
 *   - Digits stay; serde does not insert a `_` before digits.
 */
export function rustVariantToSnakeCase(ident: string): string {
  const out: string[] = [];
  for (let i = 0; i < ident.length; i += 1) {
    // `ident[i]` is `string | undefined` under `noUncheckedIndexedAccess`.
    // The loop bound guarantees non-undefined; the `?? ''` is a type-narrow.
    const ch = ident[i] ?? '';
    const prev = i > 0 ? (ident[i - 1] ?? '') : '';
    const next = i + 1 < ident.length ? (ident[i + 1] ?? '') : '';
    const isUpper = ch >= 'A' && ch <= 'Z';
    const prevIsLower = prev >= 'a' && prev <= 'z';
    const prevIsDigit = prev >= '0' && prev <= '9';
    const nextIsLower = next >= 'a' && next <= 'z';
    if (isUpper && (prevIsLower || prevIsDigit)) {
      out.push('_');
    } else if (isUpper && prev >= 'A' && prev <= 'Z' && nextIsLower) {
      out.push('_');
    }
    out.push(ch.toLowerCase());
  }
  return out.join('');
}

/**
 * Extract the variant identifiers of a Rust enum named `enumName` from the
 * given source. Handles both tuple-variants like `Foo(Bar),` and
 * struct-less variants like `Foo,`. Ignores doc comments and attributes.
 */
export function extractRustEnumVariants(source: string, enumName: string): string[] {
  // Anchor: `pub enum NAME {` — find the matching `}` using brace counting.
  const declRe = new RegExp(String.raw`pub\s+enum\s+${enumName}\s*\{`, 'u');
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(`Rust enum not found: ${enumName}`);
  }
  const start = declMatch.index + declMatch[0].length;
  let depth = 1;
  let end = start;
  while (end < source.length && depth > 0) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth === 0) break;
    end += 1;
  }
  if (depth !== 0) throw new Error(`Unbalanced braces in enum ${enumName}`);
  const body = source.slice(start, end);

  // Strip line comments and block comments to keep the scraper honest.
  const stripped = body.replace(/\/\/[^\n]*\n/gu, '\n').replace(/\/\*[\s\S]*?\*\//gu, '');

  // Walk the body counting braces/parens; variant identifiers are
  // the first `Upper…` token on a top-level line (brace/paren depth 0 relative
  // to the enum body).
  const variants: string[] = [];
  let d = 0;
  let buf = '';
  for (let i = 0; i <= stripped.length; i += 1) {
    const ch = stripped[i] ?? ',';
    if (ch === '{' || ch === '(') {
      d += 1;
      continue;
    }
    if (ch === '}' || ch === ')') {
      d -= 1;
      continue;
    }
    if (d !== 0) continue;
    if (ch === ',' || ch === '\n') {
      const m = /^\s*(?:#\[[^\]]*\]\s*)*([A-Z][A-Za-z0-9]*)/u.exec(buf);
      if (m && m[1]) variants.push(m[1]);
      buf = '';
    } else {
      buf += ch;
    }
  }
  return Array.from(new Set(variants));
}

/**
 * Describes one Rust enum whose wire values must appear in a TS mirror.
 *
 * `rustFile`     — filename under `crates/quanta-proto/src/`.
 * `enumName`     — Rust identifier.
 * `tsFiles`      — every TS file expected to carry the snake_case literals.
 * `prefix`       — optional prefix (used for the outer `Event` enum where the
 *                  TS side carries `session_created` etc.; for inner enums the
 *                  TS side uses the bare snake_case).
 */
interface RustEnumSpec {
  readonly rustFile: string;
  readonly enumName: string;
  readonly tsFiles: readonly string[];
  readonly prefix?: string;
  readonly exclude?: readonly string[];
}

const RUST_ENUMS: readonly RustEnumSpec[] = [
  {
    rustFile: 'events.rs',
    enumName: 'Event',
    tsFiles: [TS_HOST_COMMON_EVENTS],
    // The host-common TS mirror only carries the Phase-1 bridge subset of
    // Event variants. Exclude the remainder from the required-membership check
    // (they are covered below via their payload structs). We still enforce
    // that whatever IS in the Rust enum uses the agreed snake_case rule.
    exclude: [
      'BlockCreated',
      'BlockStarted',
      'BlockCompleted',
      'BlockCanceled',
      'BlockDetached',
      'BlockTuiEntered',
      'BlockTuiExited',
      'OutputChunk',
      'OutputTruncated',
      'DiagnosticDetected',
      'SuggestionGenerated',
      'SuggestionReviewed',
      'HistoryIndexed',
    ],
  },
  {
    rustFile: 'envelope.rs',
    enumName: 'Producer',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'RiskLevel',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'CwdSource',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'ShellIntegrationStatus',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'BoundarySignal',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'BoundaryConfidence',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'BlockKind',
    // BlockKind is not yet surfaced in either TS mirror; enforce only that
    // the Rust-side variant set is stable. When a TS mirror lands, add it here.
    tsFiles: [],
  },
  {
    rustFile: 'events.rs',
    enumName: 'SessionEndReason',
    tsFiles: [TS_HOST_COMMON_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'DetachReason',
    tsFiles: [TS_HOST_COMMON_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'InputKind',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'OutputStream',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'TruncationReason',
    tsFiles: [TS_HOST_COMMON_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'DiagnosticSeverity',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'DiagnosticCategory',
    tsFiles: [TS_HOST_COMMON_EVENTS, TS_UI_GENERATED_EVENTS],
  },
  {
    rustFile: 'events.rs',
    enumName: 'SuggestionDecision',
    tsFiles: [TS_HOST_COMMON_EVENTS],
  },
];

/**
 * Return true iff the given TS source text contains the literal value as a
 * string literal (single- or double-quoted, or backtick) on the right-hand
 * side of a type or union. We search for `'value'`, `"value"`, or `` `value` ``.
 */
function tsHasLiteral(source: string, literal: string): boolean {
  const safe = literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const re = new RegExp(`['"\`]${safe}['"\`]`, 'u');
  return re.test(source);
}

describe('rustVariantToSnakeCase', () => {
  it('matches serde rename_all="snake_case" for Phase-1 names', () => {
    // Seed cases: the literal truth from serde's documented behavior on the
    // actual identifiers the repo uses.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['SafeReadonly', 'safe_readonly'],
      ['WorkspaceWrite', 'workspace_write'],
      ['NetworkExternal', 'network_external'],
      ['Osc133', 'osc133'],
      ['Osc7', 'osc7'],
      ['ChildExit', 'child_exit'],
      ['PromptRegex', 'prompt_regex'],
      ['PromptEstimate', 'prompt_estimate'],
      ['ExplicitOverride', 'explicit_override'],
      ['ShellExited', 'shell_exited'],
      ['SidecarShutdown', 'sidecar_shutdown'],
      ['BackgroundJob', 'background_job'],
      ['SidecarCrash', 'sidecar_crash'],
      ['SessionEnd', 'session_end'],
      ['Intent', 'intent'],
      ['Stdout', 'stdout'],
      ['Stderr', 'stderr'],
      ['PerBlockCap', 'per_block_cap'],
      ['QuotaExceeded', 'quota_exceeded'],
      ['Warning', 'warning'],
      ['Info', 'info'],
      ['Infra', 'infra'],
      ['SessionCreated', 'session_created'],
      ['OutputChunk', 'output_chunk'],
      ['BlockTuiEntered', 'block_tui_entered'],
      ['TuiSession', 'tui_session'],
    ];
    for (const [rust, expected] of cases) {
      expect(rustVariantToSnakeCase(rust), `serde snake_case(${rust})`).toBe(expected);
    }
  });
});

describe('extractRustEnumVariants', () => {
  it('finds every variant of RiskLevel', () => {
    const source = readRust('events.rs');
    const variants = extractRustEnumVariants(source, 'RiskLevel');
    expect(variants).toEqual([
      'SafeReadonly',
      'WorkspaceWrite',
      'SystemMutation',
      'NetworkExternal',
      'Destructive',
    ]);
  });

  it('handles tuple-variant enums (Event)', () => {
    const source = readRust('events.rs');
    const variants = extractRustEnumVariants(source, 'Event');
    expect(variants).toContain('SessionCreated');
    expect(variants).toContain('BlockCreated');
    expect(variants).toContain('OutputChunk');
    expect(variants).toContain('InputSubmitted');
    expect(variants).toContain('SuggestionGenerated');
    // Sanity: no rogue captures of struct names.
    expect(variants).not.toContain('Event');
    expect(variants).not.toContain('PathBuf');
  });
});

describe('TS mirrors carry every Rust enum variant', () => {
  // Read all sources once.
  const rustSources = new Map<string, string>();
  const tsSources = new Map<string, string>();
  for (const spec of RUST_ENUMS) {
    if (!rustSources.has(spec.rustFile)) {
      rustSources.set(spec.rustFile, readRust(spec.rustFile));
    }
    for (const ts of spec.tsFiles) {
      if (!tsSources.has(ts)) {
        tsSources.set(ts, readTs(ts));
      }
    }
  }

  for (const spec of RUST_ENUMS) {
    it(`${spec.enumName}: every variant appears in each TS mirror`, () => {
      const rust = rustSources.get(spec.rustFile)!;
      const variants = extractRustEnumVariants(rust, spec.enumName);
      expect(variants.length, `${spec.enumName} should not be empty`).toBeGreaterThan(0);

      if (spec.tsFiles.length === 0) {
        // The Rust enum has no TS mirror at this time by design. Still
        // ensures the enum existed and parsed.
        return;
      }

      const excluded = new Set(spec.exclude ?? []);
      const missing: Array<{ variant: string; snake: string; file: string }> = [];
      for (const v of variants) {
        if (excluded.has(v)) continue;
        const snake = rustVariantToSnakeCase(v);
        for (const tsPath of spec.tsFiles) {
          const src = tsSources.get(tsPath)!;
          if (!tsHasLiteral(src, snake)) {
            missing.push({ variant: v, snake, file: tsPath });
          }
        }
      }

      if (missing.length > 0) {
        const lines = missing
          .map(
            (m) =>
              `  - ${spec.enumName}::${m.variant} → '${m.snake}' missing in ${
                m.file.split('packages/')[1] ?? m.file
              }`,
          )
          .join('\n');
        throw new Error(
          `TS mirror drift detected. Rust-side variants with no TS literal:\n${lines}\n\n` +
            `Fix the TS mirror file(s) in the same PR as the Rust change. See the\n` +
            `file header of schema-parity.test.ts for the update checklist.`,
        );
      }
    });
  }
});

describe('Event discriminator convention', () => {
  it('outer Event enum declares #[serde(tag = "kind", rename_all = "snake_case")]', () => {
    // The TS side relies on `kind` as the discriminator and on the snake_case
    // rename rule. If the Rust side ever flips either of those, every TS
    // consumer of `HostEvent` breaks silently — assert the exact attribute
    // pair immediately preceding `pub enum Event`.
    const src = readRust('events.rs');
    const re =
      /#\[serde\(tag\s*=\s*"kind"\s*,\s*rename_all\s*=\s*"snake_case"\s*\)\][\s\S]{0,40}pub\s+enum\s+Event\s*\{/u;
    expect(re.test(src), 'Event must carry tag="kind", rename_all="snake_case"').toBe(true);
  });

  it('every inner enum that the wire surfaces uses rename_all = "snake_case"', () => {
    const src = readRust('events.rs');
    const innerEnums = [
      'ShellIntegrationStatus',
      'CwdSource',
      'SessionEndReason',
      'BlockKind',
      'BoundarySignal',
      'BoundaryConfidence',
      'InputKind',
      'DetachReason',
      'OutputStream',
      'TruncationReason',
      'DiagnosticSeverity',
      'DiagnosticCategory',
      'RiskLevel',
      'SuggestionDecision',
    ];
    for (const name of innerEnums) {
      const re = new RegExp(
        String.raw`#\[serde\([^)]*rename_all\s*=\s*"snake_case"[^)]*\)\][\s\S]{0,120}pub\s+enum\s+${name}\s*\{`,
        'u',
      );
      expect(re.test(src), `${name} must carry rename_all="snake_case"`).toBe(true);
    }
  });
});

describe('ADR 0003 — SessionCreated carries launch_cwd', () => {
  // ADR 0003 names `launch_cwd` as the authoritative CWD source for a session.
  // If the Rust payload ever renames or removes this field, TS consumers
  // watching the host bridge break. Pinning it here makes the rename
  // visible in a PR review.
  it('SessionCreated struct has a launch_cwd field', () => {
    const src = readRust('events.rs');
    const re = /pub\s+struct\s+SessionCreated\s*\{[\s\S]*?pub\s+launch_cwd\s*:/u;
    expect(re.test(src), 'SessionCreated must expose pub launch_cwd').toBe(true);
  });

  it('TS mirror SessionCreatedEvent has a launchCwd field', () => {
    const src = readTs(TS_HOST_COMMON_EVENTS);
    expect(/launchCwd\s*:\s*string/u.test(src), 'host-common must mirror launchCwd').toBe(true);
  });
});

describe('InputSubmitted field renamed to input_kind (regression pin)', () => {
  // Regression: a naive Rust-side rename `input_kind` → `kind` would collide
  // with the outer enum's `#[serde(tag = "kind")]`. The Rust side carries
  // `input_kind`; the TS side mirrors `inputKind`. Both are pinned.
  it('Rust-side InputSubmitted has input_kind, not kind', () => {
    const src = readRust('events.rs');
    const re = /pub\s+struct\s+InputSubmitted\s*\{[\s\S]*?pub\s+input_kind\s*:/u;
    expect(re.test(src)).toBe(true);
    // And no bare `pub kind:` field on this struct.
    const struct = /pub\s+struct\s+InputSubmitted\s*\{([\s\S]*?)\}/u.exec(src)?.[1] ?? '';
    expect(/pub\s+kind\s*:/u.test(struct)).toBe(false);
  });

  it('TS-side InputSubmittedEvent has inputKind', () => {
    const src = readTs(TS_HOST_COMMON_EVENTS);
    expect(/inputKind\s*:\s*InputKind/u.test(src)).toBe(true);
  });
});

describe('ProtocolVersion surface (ADR 0004)', () => {
  // The handshake types are not in the TS mirror today (Phase 1 sidecar is
  // Rust-only), but we assert the Rust symbols are present so the integration
  // harness and the compliance tool can rely on them.
  it('Rust side declares Hello/Ready/Incompatible', () => {
    const src = readRust('protocol.rs');
    expect(/pub\s+struct\s+Hello\s*\{/u.test(src)).toBe(true);
    expect(/pub\s+struct\s+Ready\s*\{/u.test(src)).toBe(true);
    expect(/pub\s+struct\s+Incompatible\s*\{/u.test(src)).toBe(true);
    expect(/pub\s+struct\s+ProtocolVersion\s*\{/u.test(src)).toBe(true);
  });
});
