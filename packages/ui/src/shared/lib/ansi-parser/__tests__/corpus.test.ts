/**
 * End-to-end corpus tests against real-program reference captures.
 *
 * Each fixture under `fixtures/*.json` is a `{ input, spans }` pair; we parse
 * the input, merge same-style adjacent runs (chunking would produce those
 * equivalently), and assert the spans match. These are the integration
 * contract — SGR unit tests cover individual codes, the corpus ensures
 * they compose correctly for real output.
 */

import { describe, expect, it } from 'vitest';
import { AnsiParser } from '../parser.js';
import type { AnsiSpan } from '../types.js';

import rustc from '../fixtures/rustc.json' with { type: 'json' };
import grep from '../fixtures/grep.json' with { type: 'json' };
import ls from '../fixtures/ls.json' with { type: 'json' };
import curl from '../fixtures/curl.json' with { type: 'json' };
import progress from '../fixtures/progress.json' with { type: 'json' };

interface Fixture {
  readonly description: string;
  readonly input: string;
  readonly spans: readonly AnsiSpan[];
}

const FIXTURES: ReadonlyArray<readonly [string, Fixture]> = [
  ['rustc', rustc as Fixture],
  ['grep', grep as Fixture],
  ['ls', ls as Fixture],
  ['curl', curl as Fixture],
  ['progress', progress as Fixture],
];

function mergeAdjacent(spans: readonly AnsiSpan[]): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && JSON.stringify({ ...prev, text: '' }) === JSON.stringify({ ...s, text: '' })) {
      out[out.length - 1] = { ...prev, text: prev.text + s.text };
    } else {
      out.push(s);
    }
  }
  return out;
}

const enc = new TextEncoder();

describe.each(FIXTURES)('corpus fixture: %s', (name, fixture) => {
  it(`parses ${name} to the expected spans (${fixture.description})`, () => {
    const p = new AnsiParser();
    const feeds = p.feed(enc.encode(fixture.input));
    const rest = p.flush();
    const actual = mergeAdjacent([...feeds, ...rest]);
    expect(actual).toEqual(fixture.spans);
  });

  it(`parses ${name} identically when fed byte-by-byte`, () => {
    const bytes = enc.encode(fixture.input);
    const p = new AnsiParser();
    const out: AnsiSpan[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      out.push(...p.feed(bytes.subarray(i, i + 1)));
    }
    out.push(...p.flush());
    expect(mergeAdjacent(out)).toEqual(fixture.spans);
  });
});
