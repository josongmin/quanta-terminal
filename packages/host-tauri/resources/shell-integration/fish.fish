# Quanta Terminal — shell integration for fish.
#
# Emits OSC 133 prompt/command markers so Quanta can frame blocks
# authoritatively (ADR 0002). Also emits OSC 7 (cwd) and OSC 1337
# CurrentDir for iTerm2 compatibility.
#
# fish provides event handlers — fish_prompt (before prompt), fish_preexec
# (user submitted), fish_postexec (command finished). We listen on all three.
# Idempotent via a guard variable.

if set -q QUANTA_SHELL_INTEGRATION_LOADED
    exit 0 2>/dev/null; or return 0
end
set -g QUANTA_SHELL_INTEGRATION_LOADED 1

# Only interactive sessions.
if not status is-interactive
    return 0
end

function __quanta_osc
    # $argv[1] is the OSC payload (e.g. "133;A").
    printf '\033]%s\033\\' $argv[1]
end

# Percent-encode a string so it is safe to embed inside an OSC payload.
# A hostile $PWD containing ESC / BEL / newline / ST terminator would
# otherwise be able to break out of the OSC sequence and inject terminal
# state or spoof OSC 133 prompt boundaries. fish ships `string escape
# --style=url` which percent-encodes everything outside the URL-safe
# unreserved set — but it also encodes `/`, which we need to keep for OSC 7
# file:// URLs to remain parseable. We therefore re-decode `%2F` back to `/`
# on the result. Defined as a function so the test/grep can assert presence.
function __quanta_urlencode
    string escape --style=url -- $argv[1] | string replace --all '%2F' '/'
end

function __quanta_emit_cwd
    # Both $PWD and the hostname are percent-encoded — see __quanta_urlencode.
    set -l cwd $PWD
    set -l hostname (hostname 2>/dev/null)
    set -l encoded_cwd (__quanta_urlencode "$cwd")
    set -l encoded_host (__quanta_urlencode "$hostname")
    __quanta_osc "7;file://$encoded_host$encoded_cwd"
    __quanta_osc "1337;CurrentDir=$encoded_cwd"
end

# fish_prompt event fires before the prompt is drawn. We emit D (previous
# command's exit), then cwd, then A (prompt start).
#
# CRITICAL ordering note (audit P1-B, fish `$status` race):
#   `--on-event fish_prompt` handlers run in registration order, and fish does
#   NOT snapshot `$status` before dispatching them. If the user has a custom
#   `fish_prompt` function (or another `--on-event fish_prompt` handler) that
#   fires before ours and runs ANY command — even a `set`, `test`, or
#   arithmetic expansion — it mutates `$status` before Quanta reads it, and
#   we'd emit the wrong exit code in OSC 133 D.
#
#   Defense: the very first line of this handler MUST be the capture. No
#   conditional, no function call, no sub-expansion may precede it. We bind
#   into `__quanta_last_status` (namespaced, unlikely to collide) and every
#   subsequent OSC emission reads from THAT variable — never from `$status`
#   directly. The verification test (`fish.fish.test`) asserts the first
#   non-comment line of the handler is the capture.
function __quanta_prompt_start --on-event fish_prompt
    set -l __quanta_last_status $status
    __quanta_osc "133;D;$__quanta_last_status"
    __quanta_emit_cwd
    __quanta_osc "133;A"
end

# fish_preexec fires after Enter, before the command runs. Canonical 133;C
# location. The B/C markers here carry no user-controlled data, so no
# encoding is required.
function __quanta_preexec --on-event fish_preexec
    __quanta_osc "133;B"
    __quanta_osc "133;C"
end

# Optionally fish_postexec can close the command, but precmd already emits D
# on the next prompt which is the authoritative close. Keeping a postexec hook
# here would risk double-emission, so we do not register one.
