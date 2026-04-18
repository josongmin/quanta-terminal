RecursionError with a `[Previous line repeated N more times]` diagnostic
note. The parser should skip that bracketed line (it has no leading
indent guaranteed) and still emit correctly.
