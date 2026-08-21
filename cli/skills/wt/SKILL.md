---
name: wt-worktree-env
description: Use `wt` to get an isolated, runnable environment (own URL, DB, media) for every branch you work on in WordPress, Laravel or React repos that use DDEV. Decide while planning: any plan that edits files, runs migrations or runs a test suite starts with `wt new`. Also use before running the app or tests, and clean up at the end.
---

# Working in an isolated worktree with `wt`

You are in a repo that uses `wt` (per-worktree DDEV environments). Never edit files or run migrations in the main checkout. Always work inside a worktree you created.

## Deciding you need one — at plan time

Do not wait to be told. The decision belongs in the plan, before the first edit:

- The plan edits files, runs migrations, or runs a test suite → its **first step** is `wt new`, and every later step happens inside `worktree.path`.
- The work is read-only — answering a question, reading code, reviewing a diff → stay in the main checkout, take nothing.
- No plan at all (a one-line ask that turns into an edit) → take the worktree **before** the first edit, not after it. Retrofitting one means moving uncommitted work between trees.

State the choice in one line ("taking a level 1 worktree: this touches four files") and carry on — this is a standing instruction, not something to ask permission for. Several agents share this machine; the collisions a worktree prevents (one session's `git reset` erasing another's work, a test suite reading half-written files) are silent and expensive.

## Start of task

```bash
wt --json new <branch> --task "<one-line summary of what you will do>"
```

- Use a short kebab-case branch (`feat/checkout-page`). The task summary drives the isolation level: mention "migration", "schema" or "seeder" if you will change the database schema; mention "import", "media" or "upload" if you will write files into uploads/storage.
- Read `worktree.path`, `worktree.url` and `next_steps` from the JSON. `cd` into `worktree.path`. All later commands use the worktree name from `worktree.name`.
- If the command fails with code 4 (limit), run `wt ls` and `wt destroy` something you own, or ask. Code 3 means main isn't running: `ddev start` in the main checkout.

## During the task

- All tooling runs inside DDEV, never on the host. Use the passthroughs: `wt npm <name> …`, `wt composer <name> …`, `wt artisan <name> …`, `wt wp <name> …`, `wt php <name> …`, `wt mysql <name>`; or `wt exec <name> -- <cmd>`. Put `--` before tool flags (`wt npm <name> -- run build --watch`).
- Do NOT run `ddev …` directly inside a worktree directory: for level 0/1 worktrees that would create an unwanted extra DDEV project. `wt` routes the command correctly for every level.
- The site is at `worktree.url`. Use it for curl/browser checks.
- Before destructive DB experiments: `wt db snapshot <name>`; undo with `wt db restore <name>`.
- If you discover you need more isolation than you asked for (e.g. you must write media): `wt promote <name> --level 3` (or `--media proxy|copy`) changes it in place. Going to level 4 or below level 2 needs destroy + new.
- Every prompt starts with a `wt:` context line injected by the plugin — trust it for which worktree you are in and who owns it. Worktrees owned by another agent are not yours to destroy or promote; `--force` is for humans.
- Run `wt context` yourself if you lose track.

## Before opening a PR

```bash
wt db diff <name>          # any DB change must be intentional
wt db export <name>        # writes db/changes/<ts>-<name>/ — commit it with the code
```

Laravel: schema changes must be migrations, not manual SQL; `wt db diff` warns on drift.
WordPress: options/content you created are exported as JSON/WXR with URLs tokenised; do not hand-edit the export.

## End of task

```bash
wt destroy <name>             # after merge, or
wt destroy <name> --keep-branch   # if someone will review the branch
```

Never run `ddev poweroff`, `ddev delete` on projects you did not create, or `git worktree remove` directly — other agents share this machine.
