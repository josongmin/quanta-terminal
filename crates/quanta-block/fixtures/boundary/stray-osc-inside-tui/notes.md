Some TUIs (notably editors that shell out) emit stray OSC 133 markers while
still inside alt-screen. The detector is a pure stream emitter and does not
know about TUI state, so it reports every marker it sees. Per ADR 0008 the
consumer (session actor) is responsible for ignoring OSC 133 markers while a
block is in `TuiMixed` sub-state. This fixture pins the raw detector output so
the consumer-layer filtering can be asserted independently.
