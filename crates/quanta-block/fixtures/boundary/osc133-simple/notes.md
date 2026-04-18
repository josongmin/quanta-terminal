Canonical OSC 133 sequence around one command. The shell prints an `A` before
the prompt, `B` after the command is accepted, `C` before output, and `D;0`
after the command completes. This is the baseline the detector must handle,
per ADR 0002's execution-boundary contract.
