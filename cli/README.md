# wt — a runnable environment for every branch

`wt` gives each git worktree its own [DDEV](https://ddev.com) environment — its own URL, database
and media — sized to the task at hand. Built for WordPress, Drupal, Laravel and React, and for the
case where several AI agents work on one repository at the same time.

Full documentation, design notes and the isolation-level model:
**https://github.com/jhayunu/wt**

## Install

```bash
npm install -g @jhayunu/wt
```

Or, inside Claude Code, install it as a plugin (skill + `/wt` command + context hooks):

```
/plugin marketplace add jhayunu/wt
/plugin install wt@jhayunu
```

Requires DDEV + Docker and Node ≥ 20. All project tooling runs inside DDEV; no host PHP or Node is
assumed.

## Quick start

```bash
cd ~/sites/myshop          # your canonical checkout, a working DDEV project
wt init                    # writes .wt.yml + .gitignore entries
ddev start && wt doctor

wt new feat/checkout --task "add checkout page with new orders table"
#   → https://feat-checkout.ddev.site

wt wp feat-checkout plugin list      # == ddev wp, in that worktree's containers
wt artisan feat-checkout migrate     # also: npm npx pnpm yarn composer php node mysql drush
wt exec feat-checkout -- <command>

wt db diff feat-checkout             # what changed in the DB since creation
wt db export feat-checkout           # → db/changes/… — commit it with the code
wt destroy feat-checkout             # containers, worktree, branch, generated files
```

Every command takes `--json` (before the subcommand: `wt --json new …`) and `--dry-run`, and
nothing ever prompts — errors carry an exit code and a `hint`.

## Isolation levels

| level | what you get | default for |
|---|---|---|
| 0 `none` | worktree only | docs, pure code review |
| 1 `shared` | worktree; tools run in **main's** web container | React, Laravel without migrations |
| 2 `app` | own DDEV project, own DB cloned from main, media symlinked | WordPress always; Laravel with migrations |
| 3 `full` | as 2, but media copied | tasks that write media |
| 4 `clean` | own project, fresh DB, empty media | greenfield, reproducibility |

The level is inferred from the framework, the words in `--task` and `.wt.yml`; `wt promote`
changes it in place.

## Development

```bash
git clone https://github.com/jhayunu/wt && cd wt/cli
npm install
npm run test:all     # unit tests + an end-to-end run against a fake `ddev` (no Docker needed)
npm run build && npm link
```

MIT licensed. Bug reports from real projects are the most useful contribution right now — see the
maturity note in the [main README](https://github.com/jhayunu/wt#maturity).
