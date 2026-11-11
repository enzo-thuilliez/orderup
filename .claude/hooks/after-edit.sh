#!/usr/bin/env bash
# PostToolUse hook: after the agent edits a file, format and lint it, then run the
# tests related to it. Problems are sent back to the agent (exit 2) so it fixes them
# right away instead of finding out in CI. Missing tools are skipped silently.
set -uo pipefail

[[ "${KIT_HOOKS_OFF:-}" == 1 ]] && exit 0

input="$(cat)"
if command -v jq >/dev/null 2>&1; then
  file="$(jq -r '.tool_input.file_path // empty' <<<"$input")"
else
  file="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path") or "")' <<<"$input")"
fi
[[ -n "$file" && -f "$file" ]] || exit 0
file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"

# Nearest ancestor directory that contains <marker> (monorepos: apps/api, apps/web).
root_with() {
  local dir; dir="$(dirname "$file")"
  while [[ "$dir" != / ]]; do
    [[ -e "$dir/$1" ]] && { echo "$dir"; return 0; }
    dir="$(dirname "$dir")"
  done
  return 1
}

report=""
run() { # <label> <command...>: record the output when the command fails
  local out
  if ! out="$("${@:2}" 2>&1)"; then
    report+="$1 failed:"$'\n'"$(tail -n 40 <<<"$out")"$'\n\n'
  fi
}

case "$file" in
  *.py)
    if root="$(root_with pyproject.toml)" && command -v uv >/dev/null 2>&1; then
      cd "$root" || exit 0
      run "ruff format" uv run --quiet ruff format "$file"
      run "ruff check" uv run --quiet ruff check --fix "$file"
      stem="$(basename "$file" .py)"
      if [[ "$stem" == test_* ]]; then
        tests=("$file")
      else
        mapfile -t tests < <(find tests -name "test_${stem}.py" 2>/dev/null)
      fi
      (( ${#tests[@]} )) && run "pytest" uv run --quiet pytest -q -x -o addopts="" "${tests[@]}"
    fi
    ;;
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css)
    if root="$(root_with package.json)"; then
      cd "$root" || exit 0
      [[ -x node_modules/.bin/biome ]] && run "biome" node_modules/.bin/biome check --write "$file"
      if [[ -x node_modules/.bin/vitest && "$file" == *.ts* && "$file" != */e2e/* ]]; then
        run "vitest" node_modules/.bin/vitest related --run --passWithNoTests "$file"
      fi
    fi
    ;;
  *.rs)
    if root="$(root_with Cargo.toml)" && command -v cargo >/dev/null 2>&1; then
      cd "$root" || exit 0
      run "rustfmt" rustfmt --edition 2024 "$file"
      run "clippy" cargo clippy --quiet --all-targets -- -D warnings
    fi
    ;;
esac

if [[ -n "$report" ]]; then
  shown="$file"
  [[ -n "${CLAUDE_PROJECT_DIR:-}" ]] && shown="${file#"$CLAUDE_PROJECT_DIR"/}"
  printf 'Checks after editing %s:\n\n%s' "$shown" "$report" >&2
  exit 2
fi
exit 0
