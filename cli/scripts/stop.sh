#!/usr/bin/env sh
[ -f "${CLAUDE_PROJECT_DIR:-.}/.wt.yml" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}"
N=$("${CLAUDE_PLUGIN_ROOT}/bin/wt" --json ls 2>/dev/null | grep -o '"name"' | wc -l | tr -d ' ')
[ "${N:-0}" -gt 0 ] && echo "wt: $N worktree(s) still exist — destroy with \`wt destroy <name>\` or keep for review (wt ls)."
exit 0
