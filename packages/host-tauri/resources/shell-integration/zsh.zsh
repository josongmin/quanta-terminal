# Quanta Terminal — shell integration for zsh.
#
# Emits OSC 133 prompt/command markers so Quanta can frame blocks
# authoritatively (ADR 0002). Also emits OSC 7 (cwd) and OSC 1337
# CurrentDir for iTerm2 compatibility.
#
# zsh has native precmd/preexec hook arrays; we append to them instead of
# hijacking PROMPT_COMMAND. Idempotent via a guard variable.

if [[ -n "${QUANTA_SHELL_INTEGRATION_LOADED:-}" ]]; then
  return 0
fi
typeset -g QUANTA_SHELL_INTEGRATION_LOADED=1

# Only interactive shells.
[[ -o interactive ]] || return 0

autoload -Uz add-zsh-hook

__quanta_osc() {
  # $1 = OSC payload. printf is the portable emitter.
  printf '\033]%s\033\\' "$1"
}

__quanta_emit_cwd() {
  local cwd="${PWD}"
  __quanta_osc "7;file://${HOST:-}${cwd}"
  __quanta_osc "1337;CurrentDir=${cwd}"
}

# precmd fires before every prompt. We emit D (exit of last command) first,
# then cwd, then A (prompt start). $? is readable as the pipeline exit code.
__quanta_precmd() {
  local exit_code=$?
  __quanta_osc "133;D;${exit_code}"
  __quanta_emit_cwd
  __quanta_osc "133;A"
  return $exit_code
}

# preexec fires AFTER the user submits (Enter) and BEFORE the command runs.
# This is the canonical place for OSC 133;C.
__quanta_preexec() {
  __quanta_osc "133;C"
}

# Wrap PS1's trailing segment with 133;B so the primary prompt ends with a
# command-start marker. %{...%} tells zsh the bytes are zero-width so the
# line editor does not miscount. Only wrap once.
__quanta_wrap_ps1() {
  if [[ "$PS1" != *"%{"$'\033'"]133;B"$'\033'"\\\\%}"* ]]; then
    PS1="%{"$'\033'"]133;A"$'\033'"\\\\%}${PS1}%{"$'\033'"]133;B"$'\033'"\\\\%}"
  fi
}

add-zsh-hook precmd __quanta_precmd
add-zsh-hook preexec __quanta_preexec

__quanta_wrap_ps1
