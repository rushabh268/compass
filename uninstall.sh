#!/bin/sh
# One-command uninstaller for the compass shadow harness.
#
# Reverses install.sh: removes the launchd agent, wrapper, and our registrations
# in Claude, Codex, OpenCode, and zsh, while preserving the ledger and auth key unless
# --purge-state is passed. Runs under a pinned Node 24.19.0 via npx.
#
# Usage: ./uninstall.sh [--home PATH] [--codex-home PATH] [--dry-run]
#                      [--purge-state] [--skip-launchd]
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "compass uninstall requires macOS (Darwin); detected $(uname -s)." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx was not found. Install Node.js 18+ first (for example: brew install node)," >&2
  echo "then re-run ./uninstall.sh." >&2
  exit 1
fi

DIR=$(cd "$(dirname "$0")" && pwd)

exec npx --yes node@24.19.0 "$DIR/install/uninstall.mjs" "$@"
