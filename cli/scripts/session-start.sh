#!/usr/bin/env sh
# SessionStart hook: if this project uses wt, surface health + live worktrees to the agent.
[ -f "${CLAUDE_PROJECT_DIR:-.}/.wt.yml" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}"
WT="${CLAUDE_PLUGIN_ROOT}/bin/wt"
echo "wt plugin active. Use \`$WT\` (or \`wt\` if installed). Start tasks with: wt --json new <branch> --task \"...\""
"$WT" --json doctor 2>/dev/null | head -c 1500; echo
"$WT" --json ls 2>/dev/null | head -c 1500; echo
exit 0
