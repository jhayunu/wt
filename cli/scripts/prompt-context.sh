#!/usr/bin/env sh
# UserPromptSubmit hook: inject a 3-line situational summary so the agent always knows
# whether it is inside a worktree, which one, and what to run. Silent when wt isn't set up.
[ -f "${CLAUDE_PROJECT_DIR:-.}/.wt.yml" ] || { d="$PWD"; while [ "$d" != "/" ]; do [ -f "$d/.wt.yml" ] && break; d=$(dirname "$d"); done; [ -f "$d/.wt.yml" ] || exit 0; }
"${CLAUDE_PLUGIN_ROOT}/bin/wt" -q context 2>/dev/null | head -c 1200
exit 0
