#!/bin/sh
set -eu

if [ -n "${OPENCODE_HOME:-}" ]; then
  candidate="$OPENCODE_HOME"
elif [ -x "$HOME/.local/bin/opencode" ]; then
  candidate="$HOME"
elif [ -x "/home/harness_opencode/.local/bin/opencode" ]; then
  candidate="/home/harness_opencode"
else
  echo "OpenCode CLI not found. Set OPENCODE_HOME to the home directory that contains .local/bin/opencode." >&2
  exit 1
fi

export HOME="$candidate"
export PATH="$HOME/.local/bin:$PATH"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"

port=4096
if [ -f .env ]; then
  url=$(sed -n 's/^OPENCODE_API_URL=//p' .env | tail -n 1)
  case "$url" in
    *:*) port=${url##*:}; port=${port%%/*} ;;
  esac
fi

if command -v pkill >/dev/null 2>&1; then
  pkill -f "opencode.*serve --port $port" 2>/dev/null || true
fi

exec npm run dev
