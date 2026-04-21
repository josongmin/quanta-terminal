/**
 * Provider port — the UI-side abstraction the `features/ai-suggest` hook calls.
 *
 * At app boot the host binds this to one of two implementations:
 *   - `mockSuggestionPort` (dev/tests): returns canned suggestions, does not
 *     touch the bridge.
 *   - `bridgeSuggestionPort` (wired in `providers/bind-ai-port.ts`): delegates
 *     to the host bridge's `aiSuggest` method, which in Tauri lands in the
 *     `quanta_ai_suggest` IPC command implemented against the `quanta-ai`
 *     Rust crate.
 *
 * Keeping the hook wired against this port rather than the bridge directly
 * means the hook stays testable without stubbing the bridge globally; tests
 * pass a `SuggestionPort` prop/argument and assert on the port's behavior.
 */

import type { AiSuggestion } from '../../entities/ai/index.js';
import { suggestCorrection } from '../command-correction/index.js';

export interface SuggestRequest {
  readonly prompt: string;
  readonly cwd?: string;
}

/**
 * Request payload for `explainError`. Carries the triggering command, a
 * utf-8 decoded slice of its stdout/stderr, and the exit code so the AI
 * provider has enough context to explain *why* a non-zero termination
 * occurred. The output is left to the caller to bound — callers should
 * truncate to roughly the last ~4kB of text since older output is almost
 * never load-bearing for an explanation.
 */
export interface ExplainErrorRequest {
  readonly command: string;
  readonly output: string;
  readonly exitCode: number;
}

/**
 * Returned by `suggestCorrection`. A stub/mock returns an empty array to
 * signal "nothing useful to suggest" — UIs gate the hint strip on a
 * non-empty result so a missing provider renders nothing. Callers should
 * treat the first entry as the preferred suggestion; the rest are
 * alternates for a multi-chip affordance.
 */
export type CorrectionCandidates = readonly string[];

export type SuggestionPort = {
  /** Returns a suggestion for the prompt, or throws. The caller is expected
   *  to log + swallow the error and show an empty bar — the hook does this
   *  so the UI never surfaces a raw stack trace. */
  readonly suggest: (req: SuggestRequest) => Promise<AiSuggestion>;

  /**
   * Explain a non-zero exit. Stub implementations return a fixed
   * "AI provider not configured" string so the UI has a sentinel to render
   * without special-casing "no provider" at the call site. A real provider
   * wraps the request into a prompt and returns a short markdown paragraph.
   */
  readonly explainError: (req: ExplainErrorRequest) => Promise<string>;

  /**
   * Suggest alternate commands for a "command not found" typo. The port
   * implementation is a local Levenshtein pass (see `command-correction/`)
   * and does NOT require a network provider — returning a non-empty array
   * is still the default even on the mock port. The method is on the port
   * so a future real provider can augment the list with contextual picks
   * (e.g. "did you mean `docker ps` — the docker daemon is running").
   */
  readonly suggestCorrection: (typoCmd: string) => CorrectionCandidates;
};

/**
 * Dev/test mock port. Deterministic: same prompt → same suggestion, with
 * only the `receivedAt` timestamp changing between calls. The canned table
 * mirrors the mock on the Rust side (crates/quanta-ai/src/adapters/mock_provider.rs)
 * so the two environments report the same tiers for the same prompts.
 */
/** Sentinel returned by the mock `explainError`. Kept exported so UI tests
 *  and call sites can assert on the exact string without a magic-constant
 *  copy. Real providers must NOT return this value. */
export const EXPLAIN_NOT_CONFIGURED_MESSAGE = 'AI provider not configured';

export function createMockSuggestionPort(): SuggestionPort {
  return {
    suggest: async (req) => {
      const prompt = req.prompt.trim();
      if (!prompt) {
        throw new Error('mock-suggestion-port: empty prompt');
      }
      const entry = canned(prompt);
      return {
        id: entry.id,
        classified: {
          command: entry.command,
          tier: entry.tier,
          modifiers: entry.modifiers,
          rulesetVersion: 1,
        },
        rationale: entry.rationale,
        receivedAt: Date.now(),
      };
    },
    explainError: async () => EXPLAIN_NOT_CONFIGURED_MESSAGE,
    // The mock port runs the local Levenshtein corrector so the composer
    // correction chip works in tests and dev without a real AI provider.
    suggestCorrection: (typoCmd) => {
      const result = suggestCorrection({ command: typoCmd, cwd: '', history: [] });
      return result ? [result.suggested] : [];
    },
  };
}

interface CannedEntry {
  readonly id: string;
  readonly command: string;
  readonly tier: 'safe' | 'caution' | 'destructive' | 'blocked';
  readonly modifiers: readonly string[];
  readonly rationale: string;
}

function canned(prompt: string): CannedEntry {
  const p = prompt.toLowerCase();
  if (p.includes('delete') && p.includes('everything')) {
    return {
      id: 'mock-rm-rf-root',
      command: 'rm -rf /',
      tier: 'blocked',
      modifiers: ['destructive_verb', 'recursion'],
      rationale: 'Mocked: the classifier blocks this command.',
    };
  }
  if (p.includes('install') && p.includes('script')) {
    return {
      id: 'mock-curl-pipe-sh',
      command: 'curl -fsSL https://example.com/install.sh | sh',
      tier: 'destructive',
      modifiers: ['network_sourced_exec', 'pipe_to_shell'],
      rationale: 'Mocked: network-sourced exec. Review carefully.',
    };
  }
  if (p.includes('status')) {
    return {
      id: 'mock-git-status',
      command: 'git status',
      tier: 'safe',
      modifiers: ['allowlist_match'],
      rationale: 'Mocked: show repository status.',
    };
  }
  if (p.includes('background')) {
    return {
      id: 'mock-background-build',
      command: 'npm run build &',
      tier: 'destructive',
      modifiers: ['backgrounding'],
      rationale: 'Mocked: backgrounded build.',
    };
  }
  if (p.includes('sudo')) {
    return {
      id: 'mock-sudo-ls',
      command: 'sudo ls /root',
      tier: 'caution',
      modifiers: ['sudo_prefix'],
      rationale: 'Mocked: sudo-prefixed read.',
    };
  }
  return {
    id: 'mock-ls',
    command: 'ls -la',
    tier: 'safe',
    modifiers: ['allowlist_match'],
    rationale: 'Mocked: list files (default).',
  };
}

/**
 * The currently-installed port. `bindSuggestionPort` is called once at app
 * boot with either the mock or the bridge-backed port.
 *
 * We avoid a React context here to keep non-React callers (widgets that
 * already read from the zustand store) able to trigger a suggestion from
 * outside the component tree, the same pattern the host-bridge accessor uses.
 */
let installed: SuggestionPort = createMockSuggestionPort();

export function bindSuggestionPort(port: SuggestionPort): void {
  installed = port;
}

export function getSuggestionPort(): SuggestionPort {
  return installed;
}

/** Test helper — reset to the mock port. */
export function resetSuggestionPortForTests(): void {
  installed = createMockSuggestionPort();
}
