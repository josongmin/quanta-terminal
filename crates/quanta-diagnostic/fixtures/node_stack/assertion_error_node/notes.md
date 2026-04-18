Node's `AssertionError [ERR_ASSERTION]: …` prefix. The regex captures the
class; the bracketed code is kept inside the message. The `:` between
class and `[ERR_ASSERTION]` means the regex captures "[ERR_ASSERTION]: 1 == 2"
as the message portion.
