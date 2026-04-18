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

function __quanta_emit_cwd
    set -l cwd $PWD
    set -l hostname (hostname 2>/dev/null)
    __quanta_osc "7;file://$hostname$cwd"
    __quanta_osc "1337;CurrentDir=$cwd"
end

# fish_prompt event fires before the prompt is drawn. We emit D (previous
# command's exit), then cwd, then A (prompt start).
function __quanta_prompt_start --on-event fish_prompt
    # $status (last exit code) must be captured immediately; any command below
    # would overwrite it.
    set -l exit_code $status
    __quanta_osc "133;D;$exit_code"
    __quanta_emit_cwd
    __quanta_osc "133;A"
end

# fish_preexec fires after Enter, before the command runs. Canonical 133;C
# location.
function __quanta_preexec --on-event fish_preexec
    __quanta_osc "133;B"
    __quanta_osc "133;C"
end

# Optionally fish_postexec can close the command, but precmd already emits D
# on the next prompt which is the authoritative close. Keeping a postexec hook
# here would risk double-emission, so we do not register one.
