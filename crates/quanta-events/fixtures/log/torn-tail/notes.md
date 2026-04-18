Truncated tail: we append two clean records, then a third whose frame header
or body is cut short (simulated by the test appending additional bytes then
truncating the file). The reader must stop at the last fully-readable frame
and report the truncated tail as a recoverable state, not raise a hard error.
Per ADR 0011, torn writes on the trailing segment are expected after crashes.
