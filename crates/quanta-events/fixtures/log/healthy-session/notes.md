Baseline replay: four well-formed records in order produce exactly four
records on read-back, and the reader returns `Ok`. Pins the zstd-frame +
length-prefix + checksum path under the happy case.
