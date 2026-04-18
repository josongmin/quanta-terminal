# ANSI Parser Corpus

Each fixture is a `(input, expected spans)` pair representing a real-world
ANSI byte stream. These corpora are exercised by `corpus.test.ts`.

| File                 | Source                                                      |
| -------------------- | ----------------------------------------------------------- |
| `rustc.json`         | `rustc` error output with carets, bold, red, colored spans. |
| `grep.json`          | `grep --color=always` with match highlight + line numbers.  |
| `ls.json`            | `ls --color=always` directory listing.                      |
| `curl.json`          | `curl -v` verbose output with `> <` direction markers.      |
| `progress.json`      | A progress bar that rewrites with `\r`.                     |

Fixture format:

```json
{
  "input": "escape-coded string with \\u escapes",
  "spans": [ { "text": "...", "fg": { "kind": "named", "index": 1 } }, ... ]
}
```

`input` is the raw text passed through `TextEncoder.encode`; `spans` is the
expected output after `feed + flush`, with adjacent same-style runs merged
(the corpus test applies the same merge routine streaming tests use).
