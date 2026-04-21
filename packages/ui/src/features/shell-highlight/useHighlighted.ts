/**
 * useHighlighted — React hook that turns composer text into a stream of
 * `{ text, className }` spans the overlay can render directly.
 *
 * The hook owns three concerns:
 *   1. Tokenizing the input via `shared/lib/shell-tokenize`.
 *   2. Reclassifying the first-word-per-statement into known/unknown via
 *      `classifyCommand`, using both the built-in allowlist and the user's
 *      local history (pulled from the autosuggest history source, which
 *      already aggregates by unique command).
 *   3. Emitting whitespace runs between tokens as plain-text spans so the
 *      overlay's `white-space: pre` wrap lines up with the textarea's
 *      character grid.
 *
 * All spans, including whitespace gaps, are returned in a single flat array
 * so the renderer can map over them without any reconstruction math.
 *
 * Gates — when any of these is true, the hook returns a single un-classified
 * `text` span (or null for empty input), mirroring the overlay's "plain
 * fallback" mode:
 *   - `disabled` (password mode from the Composer).
 *   - `composing` (IME composition in progress — showing highlights while
 *     the input is transient double-renders the composed text visually).
 */

import { useMemo } from 'react';
import { tokenize, type Token } from '../../shared/lib/shell-tokenize/index.js';
import {
  DEFAULT_KNOWN_COMMANDS,
  classifyCommand,
} from './classify.js';
import { useHistoryEntries } from '../autosuggest/index.js';

export interface HighlightedSpan {
  readonly text: string;
  /** CSS module class name, or null for plain (unstyled) text. */
  readonly className: string | null;
}

export interface UseHighlightedArgs {
  readonly value: string;
  /** Password mode disables highlighting entirely. */
  readonly disabled?: boolean;
  /** During IME composition, suppress highlighting so the composed text
   *  doesn't appear double-rendered (once via overlay, once via textarea
   *  composition caret). */
  readonly composing?: boolean;
  /**
   * A `styles` object from the composer's CSS module, keyed by the class
   * names declared there: `hlCommandKnown`, `hlCommandUnknown`, `hlFlag`,
   * `hlString`, `hlPath`, `hlVar`, `hlOperator`, `hlSubshell`, `hlComment`.
   * Passing the styles object here keeps this hook decoupled from any
   * specific component's module namespace.
   */
  readonly styles: Readonly<Record<string, string>>;
  /** Override the built-in allowlist. Tests use this; production passes undefined. */
  readonly knownCommands?: ReadonlySet<string>;
  /** Override the history source. When undefined, the hook pulls from the
   *  block-store via `useHistoryEntries`. */
  readonly historyCommands?: ReadonlySet<string>;
}

/** Map a token kind to the CSS class name. */
function classForToken(
  token: Token,
  input: string,
  styles: Readonly<Record<string, string>>,
  known: ReadonlySet<string>,
  history: ReadonlySet<string> | undefined,
): string | null {
  switch (token.kind) {
    case 'command': {
      const text = input.slice(token.start, token.end);
      const classification = classifyCommand(text, {
        knownCommands: known,
        ...(history !== undefined ? { historyCommands: history } : {}),
      });
      return classification === 'known'
        ? (styles.hlCommandKnown ?? null)
        : (styles.hlCommandUnknown ?? null);
    }
    case 'flag':
      return styles.hlFlag ?? null;
    case 'string':
      return styles.hlString ?? null;
    case 'path':
      return styles.hlPath ?? null;
    case 'var':
      return styles.hlVar ?? null;
    case 'operator':
      return styles.hlOperator ?? null;
    case 'subshell':
      return styles.hlSubshell ?? null;
    case 'comment':
      return styles.hlComment ?? null;
    case 'text':
    default:
      return null;
  }
}

export function useHighlighted(args: UseHighlightedArgs): HighlightedSpan[] {
  const {
    value,
    disabled = false,
    composing = false,
    styles,
    knownCommands,
    historyCommands,
  } = args;

  // Always call the history hook — React hook rules require a stable call
  // order. When `historyCommands` is passed by the caller, we ignore the
  // subscribed entries.
  const entries = useHistoryEntries();

  return useMemo((): HighlightedSpan[] => {
    if (value.length === 0) return [];

    // Fallback modes: plain text span, no classes.
    if (disabled || composing) {
      return [{ text: value, className: null }];
    }

    const knownSet = knownCommands ?? DEFAULT_KNOWN_COMMANDS;
    const historySet: ReadonlySet<string> | undefined =
      historyCommands ?? (() => {
        const s = new Set<string>();
        for (const e of entries) {
          // The first word of the command is what the tokenizer will flag
          // as "command" — match on that so aliases with args (e.g.
          // "git status") register "git" as known.
          const firstWord = e.command.split(/\s+/, 1)[0];
          if (firstWord) s.add(firstWord);
        }
        return s;
      })();

    const tokens = tokenize(value);
    const out: HighlightedSpan[] = [];
    let cursor = 0;
    for (const tok of tokens) {
      if (tok.start > cursor) {
        // Whitespace / gap — emit un-styled span so widths still align.
        out.push({ text: value.slice(cursor, tok.start), className: null });
      }
      const text = value.slice(tok.start, tok.end);
      const className = classForToken(tok, value, styles, knownSet, historySet);
      out.push({ text, className });
      cursor = tok.end;
    }
    if (cursor < value.length) {
      out.push({ text: value.slice(cursor), className: null });
    }
    return out;
  }, [value, disabled, composing, styles, knownCommands, historyCommands, entries]);
}
