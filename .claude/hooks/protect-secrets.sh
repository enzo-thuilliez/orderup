#!/usr/bin/env bash
# PreToolUse hook: stop the agent from reading or writing secret files.
# Blocks .env files (not .env.example / .sample / .template), private keys and
# credential files, whether the agent uses a file tool or a shell command.
# Exit 2 blocks the tool call and shows the reason to the agent.
set -uo pipefail

[[ "${KIT_HOOKS_OFF:-}" == 1 ]] && exit 0

input="$(cat)"

field() { # <jq path>  — jq when available, python3 otherwise
  if command -v jq >/dev/null 2>&1; then
    jq -r "$1 // empty" <<<"$input"
  else
    python3 -c 'import json,sys
d=json.loads(sys.stdin.read())
for k in sys.argv[1].lstrip(".").split("."):
    d=d.get(k) if isinstance(d,dict) else None
print(d if isinstance(d,str) else "")' "$1" <<<"$input"
  fi
}

is_secret() { # <path or word>
  local base="${1##*/}"
  base="${base%\"}"; base="${base%\'}"; base="${base#\"}"; base="${base#\'}"
  case "$base" in
    .env.example|.env.sample|.env.template|.env.dist) return 1 ;;
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa|id_rsa.*|id_ed25519|id_ed25519.*|.netrc|.pgpass) return 0 ;;
  esac
  return 1
}

block() {
  echo "Blocked by .claude/hooks/protect-secrets.sh: '$1' looks like a secret file." >&2
  echo "Agents never read or write secrets. Ask the user to do it, or use .env.example." >&2
  exit 2
}

tool="$(field .tool_name)"
case "$tool" in
  Bash)
    cmd="$(field .tool_input.command)"
    # Split on whitespace, quotes, redirections and separators; check every word.
    set -f   # no glob expansion of the words
    for word in $(tr ' \t\n<>|;&()=' '\n' <<<"$cmd"); do
      is_secret "$word" && block "$word"
    done
    ;;
  *)
    for key in .tool_input.file_path .tool_input.notebook_path .tool_input.path; do
      path="$(field "$key")"
      [[ -n "$path" ]] && is_secret "$path" && block "$path"
    done
    ;;
esac
exit 0
