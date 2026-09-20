#!/bin/sh
# One-command installer for the compass shadow harness.
#
# Works on any macOS machine that has Node/npm available: it uses npx to run the
# bootstrapper under a pinned Node 24.19.0, sidestepping whatever Node version the
# host happens to have. The bootstrapper then provisions the persistent pinned
# runtime, state directory, a freshly generated auth key, the launchd agent, and
# idempotent registration into the selected clients. Claude and OpenCode are the
# default; Codex is opt-in and its new hooks need review in Codex's /hooks UI.
#
# Usage: ./install.sh [--adapters claude,opencode,codex] [--codex-home PATH]
#                    [--home PATH] [--dry-run] [--skip-runtime] [--skip-launchd]
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "compass install requires macOS (Darwin); detected $(uname -s)." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx was not found. Install Node.js 18+ first (for example: brew install node)," >&2
  echo "then re-run ./install.sh. npx fetches the pinned Node 24.19.0 automatically." >&2
  exit 1
fi

DIR=$(cd "$(dirname "$0")" && pwd)

exec npx --yes node@24.19.0 "$DIR/install/bootstrap.mjs" "$@"
