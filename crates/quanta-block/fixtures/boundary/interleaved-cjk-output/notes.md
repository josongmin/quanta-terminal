Non-boundary output bytes that happen to be CJK (Korean "안녕하세요 ",
Chinese "你好世界", emoji "🌏") surrounding two real OSC 133 markers. The
detector MUST:

- emit the two boundary events (`PromptStart`, `CommandDone { exit_code: 0 }`),
- NOT emit spurious events for the CJK bytes,
- NOT panic or corrupt state when fed the CJK bytes chunk-by-chunk (the
  corpus test runs a single-shot feed and a split-in-half feed).

Guards against regressions where the VTE parser is replaced with a naive
char iterator that would misinterpret continuation bytes as print ops.
