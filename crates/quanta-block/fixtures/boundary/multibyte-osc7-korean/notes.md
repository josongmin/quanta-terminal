OSC 7 with a Korean working directory. Each Hangul syllable is a 3-byte
UTF-8 sequence (e.g. `한` = `ED 95 9C`). The detector must pass through the
bytes without loss and the event's `cwd` string must round-trip to the
original Korean path.

This fixture is a stake-in-the-ground against the classic "한글깨짐" bug:
a regression that normalizes PTY bytes through `String::from_utf8_lossy`
would surface here as `/home/<U+FFFD>...` in the expected vs. actual diff.
