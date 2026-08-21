#!/usr/bin/env sh
# SessionStart hook: if this project uses wt, surface health + live worktrees to the agent.
[ -f "${CLAUDE_PROJECT_DIR:-.}/.wt.yml" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
WT="${CLAUDE_PLUGIN_ROOT}/bin/wt"
# Never build from a hook — a fresh plugin install has no dist/ and building blocks the session.
if ! WT_NO_BUILD=1 sh "$WT" --version >/dev/null 2>&1; then
  echo "wt plugin installed but not built yet. Run once: sh \"$WT\" --version   (installs deps + compiles, a few minutes)"
  exit 0
fi
echo "wt plugin active. Use \`$WT\` (or \`wt\` if installed). Start tasks with: wt --json new <branch> --task \"...\""
sh "$WT" --json doctor 2>/dev/null | head -c 1500; echo
sh "$WT" --json ls 2>/dev/null | head -c 1500; echo
exit 0
