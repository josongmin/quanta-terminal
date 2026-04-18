First frame after the error is a native `<anonymous>` pseudo-frame which
our regex does not match (no `path:line:col`). The parser clears the
pending message after attempting the first frame, so the subsequent `run`
frame does not emit either. Accepted miss — matches ADR precision rule.
