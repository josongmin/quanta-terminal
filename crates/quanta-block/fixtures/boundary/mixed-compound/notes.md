Compound command (`foo; bar`) executed as a single submission. The shell
emits one A-B-C-D cycle because the whole pipeline is one input line; the
boundary detector must not fabricate extra boundaries for the `;` separator.
Compound-ness is detected at the session layer by inspecting the input text,
not by the VTE detector.
