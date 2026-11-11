#!/usr/bin/env bash
# Runs once when the dev container is created: the kit's CLIs, then the project's
# dependencies. Safe to run again.
set -euo pipefail

GITLEAKS_VERSION=8.30.1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
mkdir -p "$HOME/.local/bin"

command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
command -v pre-commit >/dev/null || uv tool install pre-commit

if ! command -v gitleaks >/dev/null; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) arch="" ;;
  esac
  [[ -n "$arch" ]] && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_$arch.tar.gz" |
    tar -xz -C "$HOME/.local/bin" gitleaks
fi

command -v claude >/dev/null || { command -v npm >/dev/null && npm install -g @anthropic-ai/claude-code; } || true

[[ -f .pre-commit-config.yaml && -d .git ]] && pre-commit install

# Project dependencies: the npm workspaces are installed from the root.
for dir in .; do
  [[ -d "$dir" ]] || continue
  [[ -f "$dir/pyproject.toml" ]] && (cd "$dir" && uv sync)
  [[ -f "$dir/package.json" ]] && (cd "$dir" && npm ci)
  [[ -f "$dir/Cargo.toml" ]] && (cd "$dir" && cargo fetch)
done
echo "Dev container ready."
