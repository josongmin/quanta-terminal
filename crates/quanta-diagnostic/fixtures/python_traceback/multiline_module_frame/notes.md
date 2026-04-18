Third-party frames from site-packages. `ConnectionError` ends in `Error`
so the class regex matches. The innermost frame is the api.py:59 `request`
entry. A workspace-aware scorer downranks this via `path_resolvable=false`;
the fixture still asserts the emission so the parser contract is precise.
