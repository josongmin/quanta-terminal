A single payload byte is flipped after the checksum is computed; the record's
stored xxh3-32 no longer matches. The reader must surface a
`ChecksumMismatch` error rather than accepting garbage. Phase 1 aborts the
replay at the first bad record; ADR 0011 leaves skip-and-report as a
hardening decision for later (tracked as a Round 2 follow-up).
