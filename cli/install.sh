#!/usr/bin/env sh
# Install wt globally. Usage:
#   curl -fsSL https://raw.githubusercontent.com/jhayar/wt/main/cli/install.sh | sh
# or from a local checkout:  sh cli/install.sh
set -e
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }
need node; need npm; need git
command -v ddev >/dev/null 2>&1 || echo "warning: ddev not found on PATH (https://ddev.readthedocs.io/en/stable/users/install/)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "node >= 20 required (have $(node -v))"; exit 1; }

if [ -f "$(dirname "$0")/package.json" ]; then
  echo "installing from local checkout…"
  (cd "$(dirname "$0")" && npm install --silent && npm run -s build && npm link --silent)
else
  echo "installing from npm…"
  npm install -g @jhayar/wt
fi
echo "installed: $(command -v wt)"
echo "next: cd <your ddev project> && wt init"
echo "claude code skill: wt skill install   (copies the wt skill into ~/.claude/skills)"
