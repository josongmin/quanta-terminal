OSC 7 carrying an emoji path. Covers:

- a single 4-byte codepoint (`👋` = `F0 9F 91 8B`), the widest UTF-8 form;
- a ZWJ emoji sequence (`🏳️‍🌈` = 🏳 + VS16 + ZWJ + 🌈). This is six codepoints
  but renders as one grapheme; the detector must preserve every codepoint.

Guards against regressions where the OSC payload is trimmed at a byte count
rather than the terminator, or where the domain event's `cwd: String`
construction drops trailing bytes.
