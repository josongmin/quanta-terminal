Precision test: an `error:` without a `-->` span must NOT produce a
diagnostic. Per ADR 0007 §Confidence Scoring we prefer to miss rather than
emit a locationless claim.
