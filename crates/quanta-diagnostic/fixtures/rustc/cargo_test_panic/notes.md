`cargo test` panic frame. The parser anchors on the `thread '…' panicked at
path:line:col:` line and records the test name as `symbol`. The
`assertion left == right` prelude appears AFTER the panic line in Rust
1.78, so the parser uses a bare "panicked" message.
