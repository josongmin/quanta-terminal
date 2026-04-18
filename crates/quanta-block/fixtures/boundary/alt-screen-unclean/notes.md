An unclean TUI exit: `?1049h` with no matching `l`. The detector itself emits
only the enter event; the session-level consumer is responsible for detecting
the unclean exit via child-exit while still in TUI mode (ADR 0008). The fixture
exists to pin the pure-detector behaviour so higher-layer logic does not try
to "rescue" a missing exit by fabricating one inside the VTE parser.
