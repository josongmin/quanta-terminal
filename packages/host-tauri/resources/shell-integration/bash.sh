# Quanta Terminal — shell integration for bash.
#
# Emits OSC 133 prompt/command markers so Quanta can frame blocks
# authoritatively (ADR 0002 "Execution Boundary Contract"). Also emits OSC 7
# for cwd reports and OSC 1337 CurrentDir for iTerm2 compatibility.
#
# OSC 133 contract:
#   A — prompt start (emitted before PS1 is rendered)
#   B — prompt end / command start (emitted at end of PS1, just before input)
#   C — command executed / output start (emitted via DEBUG trap before user cmd)
#   D;<exitcode> — command done (emitted from PROMPT_COMMAND on next prompt)
#
# This script is idempotent: a guard variable prevents double-binding when
# bashrc is sourced multiple times.

if [ -n "${QUANTA_SHELL_INTEGRATION_LOADED:-}" ]; then
  return 0 2>/dev/null || true
fi
QUANTA_SHELL_INTEGRATION_LOADED=1

# Only meaningful inside an interactive terminal; no-op under ssh/pipe/etc.
case "$-" in
  *i*) ;;
  *) return 0 2>/dev/null || true ;;
esac

# ---- OSC emitters (ESC ] ... ESC \) -----------------------------------------
__quanta_osc() {
  # $1 = OSC payload (e.g. "133;A"); writes to /dev/tty-equivalent stderr.
  printf '\033]%s\033\\' "$1"
}

__quanta_emit_cwd() {
  # OSC 7: file URL of cwd. Also OSC 1337 CurrentDir for iTerm2 parity.
  local cwd
  cwd="${PWD:-$(pwd)}"
  __quanta_osc "7;file://${HOSTNAME:-}${cwd}"
  __quanta_osc "1337;CurrentDir=${cwd}"
}

# ---- Trap hooks -------------------------------------------------------------
# PROMPT_COMMAND fires before each prompt. We use it to:
#   1. close the previous command with 133;D;<exit>
#   2. emit cwd (OSC 7 / OSC 1337)
#   3. open the new prompt with 133;A
__quanta_precmd() {
  local exit_code=$?
  __quanta_osc "133;D;${exit_code}"
  __quanta_emit_cwd
  __quanta_osc "133;A"
  return $exit_code
}

# DEBUG trap fires before every simple command. We use it to emit 133;C once
# after the user submits a command (between prompt-end and output-start).
# Guard with __quanta_in_prompt so we don't emit 133;C for commands that run
# as part of the prompt itself (PROMPT_COMMAND).
__quanta_preexec() {
  # $BASH_COMMAND is the command about to run. Skip the precmd callback itself.
  if [ -n "${COMP_LINE:-}" ] || [ "${BASH_COMMAND}" = "__quanta_precmd" ]; then
    return 0
  fi
  if [ -z "${__quanta_preexec_done:-}" ]; then
    __quanta_osc "133;C"
    __quanta_preexec_done=1
  fi
}

# Hook PS1 so the end of the prompt carries 133;B. We wrap PS1 with the
# marker inside \[...\] so bash does not count the bytes toward line width.
__quanta_wrap_ps1() {
  case "$PS1" in
    *"\[\033]133;B\033\\\\\]"*) ;; # already wrapped
    *) PS1="\[\033]133;A\033\\\]${PS1}\[\033]133;B\033\\\]" ;;
  esac
}

# Clear the preexec guard on every new prompt so the next command re-emits C.
__quanta_reset_preexec_guard() {
  __quanta_preexec_done=
}

# Compose PROMPT_COMMAND. We prepend our precmd callback; if the user had a
# PROMPT_COMMAND already we preserve it after ours.
case "${PROMPT_COMMAND:-}" in
  *__quanta_precmd*) ;;
  *)
    if [ -n "${PROMPT_COMMAND:-}" ]; then
      PROMPT_COMMAND="__quanta_precmd; __quanta_reset_preexec_guard; ${PROMPT_COMMAND}"
    else
      PROMPT_COMMAND="__quanta_precmd; __quanta_reset_preexec_guard"
    fi
    ;;
esac

# Bind the DEBUG trap — bash's closest equivalent to zsh preexec.
trap '__quanta_preexec' DEBUG

# Wrap PS1 now (user may override later; PROMPT_COMMAND reasserts by re-running
# __quanta_precmd which emits 133;A itself, so the wrap is belt-and-braces).
__quanta_wrap_ps1
