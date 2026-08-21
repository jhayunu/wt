---
description: Create an isolated worktree environment for a task and start working in it
argument-hint: <branch> "<task summary>"
allowed-tools: Bash(wt:*), Bash(${CLAUDE_PLUGIN_ROOT}/bin/wt:*)
---

Create an isolated environment with `wt` for the branch and task given in `$ARGUMENTS` (first token = branch, rest = task summary), then work inside it.

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/wt --json new <branch> --task "<summary>"`. If `.wt.yml` is missing, run `${CLAUDE_PLUGIN_ROOT}/bin/wt init` first and show me its ACTION lines before continuing.
2. Read `worktree.path`, `worktree.url`, `level_reasons` and `next_steps` from the JSON and summarise them in one line.
3. `cd` into `worktree.path` for all further edits and commands. Use `wt exec <name> -- …` to run wp/artisan/npm inside the environment.
4. Follow the `wt-worktree-env` skill for the rest of the task (DB diff/export before PR, destroy at the end).
