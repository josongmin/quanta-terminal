SyntaxError with a first frame in Node internals. We emit the first frame
as-is; the scorer's path_resolvable signal downranks internal paths at
runtime.
