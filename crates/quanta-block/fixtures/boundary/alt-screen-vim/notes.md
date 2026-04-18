Typical `vim` invocation: prompt, command, output-start, alt-screen enter,
TUI body, alt-screen exit, command-done. Verifies the detector emits balanced
enter/exit events regardless of the intervening body bytes. Per ADR 0008 the
downstream consumer is expected to hold the block in `TuiMixed` sub-state
between these events.
