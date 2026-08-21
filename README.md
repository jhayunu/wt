# wt — a runnable environment for every branch

[![ci](https://github.com/jhayunu/wt/actions/workflows/ci.yml/badge.svg)](https://github.com/jhayunu/wt/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`wt` gives each git worktree its own [DDEV](https://ddev.com) environment — its own URL, database
and media — sized to the task at hand. Built for WordPress, Drupal, Laravel and React, and built
for the case where several AI agents work on one repository at the same time.

```console
$ wt new feat/checkout --task "add checkout page with a new orders table"
level 2 (app): wordpress floor=2
plan:
  1. git worktree add .wt/worktrees/feat-checkout (feat/checkout)
  2. write .ddev/config.wt.local.yaml (+ env files)
  3. media: symlink wp-content/uploads
  4. db: snapshot from myshop
  5. ddev start → https://feat-checkout.ddev.site
  6. db change-tracking baseline (wp-changeset, snapshot-diff)
created feat-checkout (level 2 app, wordpress, owner you@laptop) at ~/sites/myshop/.wt/worktrees/feat-checkout
https://feat-checkout.ddev.site

$ wt wp feat-checkout option get home
https://feat-checkout.ddev.site

$ wt db diff feat-checkout
[snapshot-diff]
  CREATE TABLE `wp_orders` (…);
  wp_options: 2 row(s) changed
```

## Why

A `git worktree` gives you an isolated set of *files*. It does not give you an isolated
*application*: the second tree still points at one database, one uploads directory, one
hostname. So two agents on two branches quietly share state — one runs a migration and the
other's tests start failing; one imports media and it appears on the other's site.

Spinning up a full environment per branch fixes that but is slow and wasteful, and most tasks
don't need it. `wt` picks the cheapest isolation that is still correct for the task, from "just
a worktree" up to "own containers, own database, own media", and can promote in place when a
task turns out to need more.

It also treats the database as something that has to be versioned: a worktree records a baseline
when created, and `wt db diff/export` turns the delta into files you commit alongside the code.

## Requirements

- [DDEV](https://ddev.readthedocs.io/en/stable/users/install/) (developed against v1.25) and Docker
- Node ≥ 20 (for the CLI itself; all project tooling runs inside DDEV)
- A git repository with a working DDEV project

## Install

**As a Claude Code plugin** (adds the skill, the `/wt` command and the context hooks):

```
/plugin marketplace add jhayunu/wt
/plugin install wt@jhayunu
```

Then once per machine:

```bash
wt skill install     # or: "$CLAUDE_PLUGIN_ROOT"/bin/wt skill install
```

That copies the skill into `~/.claude/skills/wt` **and** adds a short "Worktrees (wt)" section to
`~/.claude/CLAUDE.md` — the rule that tells an agent *when* to take a worktree (at plan time,
before the first edit), scoped to repos that have a `.wt.yml`. A skill only fires once a task is
under way; CLAUDE.md is read before that, which is why the trigger has to live there too.
`--no-claude-md` opts out; `--project` writes both into the current repo instead.

**As a plain CLI** (no Claude Code required):

```bash
npm install -g @jhayunu/wt
# or from a checkout:
git clone https://github.com/jhayunu/wt && cd wt/cli && npm install && npm run build && npm link
```

## Set up a repository

```bash
cd ~/sites/myshop        # your canonical checkout, a working DDEV project
wt init                  # writes .wt.yml + .gitignore entries, adds the worktree rule to CLAUDE.md
ddev start
wt doctor                # every check should be ✓
```

`wt clone git@github.com:org/myshop.git` does clone + init + `ddev start` in one go on a new
machine. Your committed `.ddev/config.yaml` is never modified — `wt` writes only
`.ddev/config.wt.local.yaml` inside each worktree, and DDEV merges it on top.

## Daily use

```bash
wt new feat/checkout --task "add checkout page with new orders table"

wt wp feat-checkout plugin list           # == ddev wp, in that worktree's containers
wt artisan feat-checkout migrate          # also: npm npx pnpm yarn composer php node mysql drush
wt exec feat-checkout -- <any command>

wt db diff feat-checkout                  # what changed in the DB since creation
wt db export feat-checkout                # → db/changes/<ts>-feat-checkout/ — commit it with the code
wt destroy feat-checkout                  # containers, worktree, branch, generated files
```

```bash
wt promote feat-checkout --level 3        # in place; also --media proxy|symlink|copy|none
wt ls                                     # what exists, at which level, owned by whom
wt context                                # where am I? (injected into every Claude Code prompt)
wt pool fill 2                            # pre-build environments; wt new then claims one in seconds
wt db apply feat-checkout                 # replay committed changesets, idempotent via a ledger table

# when the work is done: merge back into the branch it came from, then clean up
wt finish feat-checkout                    # prints the plan, changes nothing
wt finish feat-checkout --confirm          # merge --no-ff, delete branch, destroy env
wt gc                                     # remove stale or merged worktrees
```

Every command takes `--json` (before the subcommand: `wt --json new …`) and `--dry-run`. Nothing
ever prompts. Errors carry an exit code and a `hint`: 2 name clash · 3 main not running ·
4 concurrency limit · 5 not found · 6 ddev missing · 8 policy violation.

## Isolation levels

| level | what you get | default for |
|---|---|---|
| 0 `none` | worktree only | docs, pure code review |
| 1 `shared` | worktree; `wt npm/composer/artisan/…` run in **main's** web container | React, Laravel without migrations |
| 2 `app` | own DDEV project, own DB cloned from main, media symlinked | WordPress always; Laravel with migrations |
| 3 `full` | as 2, but media copied | tasks that write media |
| 4 `clean` | own project, fresh DB, empty media | greenfield, reproducibility |

The level is inferred from the framework floor, keywords in `--task` and `.wt.yml: hints`, then
clamped by `min_level` / `max_level` / `policy.allow_levels`; `--level` overrides. `wt promote`
changes level or media mode in place (0/1→2+, 2↔3, any media swap); level 4 and demotion below 2
need a recreate.

## Databases and media

**DB strategies** — `snapshot` (default; binary snapshot of main, needs main running) ·
`dump` (export/import, crosses DB versions) · `seedfile` (`db/seed.sql.gz` refreshed by
`wt db seed`, works with main stopped, can pull from your host with `seed.refresh: ddev-pull`) ·
`fresh` · `none`.

**Media modes** — `symlink` (default, zero copy, writes leak back to main) · `copy` (APFS clone
on macOS, fully isolated) · `proxy` (nginx `try_files` falls back to main through the DDEV
router: no filesystem coupling, writes stay local) · `none`.

**Change tracking.** Database edits have no git. `wt` records a baseline at creation and exposes
`diff / export / apply / status` through a pluggable `DbChangeProvider`:

- `snapshot-diff` — framework-agnostic: real `ALTER/CREATE/DROP` statements from a CREATE TABLE
  differ, plus row upserts for tables you list in `track_tables` — only the rows that actually
  differ, with `db.deny_rows` keeping credentials and self-churning rows (`cron`, transients)
  out of the changeset entirely
- `laravel-migrations` — the migrations *are* the changeset; warns when the schema drifted outside them
- `wp-changeset` — changed `wp_options` as JSON and a WXR export of modified posts, with URLs
  tokenised as `{{WT_URL}}`
- a `wt_changesets` ledger in each worktree DB makes `wt db apply` idempotent
- Liquibase, Flyway or Atlas: implement the interface in one file and register it in `src/providers/index.ts`

## Ownership, policy and the pool

Each worktree records an `owner` (`WT_OWNER`, else the Claude Code session, else `user@host`) and
a lease (`policy.lease_hours`, default 24). Destroying or promoting someone else's worktree
inside its lease needs `--force`, so parallel agents cannot tidy each other's work away.
`.wt.yml: policy` also carries `allow_levels`, `require_task` and `allow_destroy: own|any`.

`pool.size: N` plus `wt pool fill` keeps N stopped, pre-built level-2 environments on throwaway
branches. `wt new` claims one when the level, DB strategy and media mode match — seconds instead
of a clone. `wt pool drain` removes them.

## Everything runs inside DDEV

No host PHP or Node is assumed. `wt <tool> <name> …` maps to `ddev <tool>` for level ≥ 2
worktrees and to `ddev exec --dir …` in main's container at levels 0–1. Do **not** run `ddev`
directly inside a level 0/1 worktree: that directory carries `.ddev/config.yaml`, so DDEV would
register a stray project named after the folder.

## Layout

```
myshop/                              DDEV project "myshop"
├── .wt.yml                          committed policy
└── .wt/                             gitignored state: manifest.json, lock, baseline/
    └── worktrees/feat-checkout/     DDEV project "feat-checkout"
        ├── .ddev/config.wt.local.yaml   generated
        ├── wp-config-wt.php | .env      generated
        ├── wp-content/uploads -> ../../../../wp-content/uploads
        └── db/changes/                  committed DB changesets
```

Everything `wt` generates is recorded in `.wt/manifest.json`, so `wt destroy` removes exactly
what was created and nothing else.

## Maturity

v0.3, and honest about what that means:

- **Verified on real DDEV** (v1.25.1):
  - levels 0 and 1 on a Laravel + React project — creation, tool routing into main's
    container, dependency handling, destroy;
  - level 2 on a WordPress project, with mutagen enabled — database cloned by snapshot,
    URL rewriting, symlinked media served through the router, `wt db diff/export/apply`
    round-tripping, the warm pool claimed with its data intact, `wt finish`, and destroy
    leaving nothing behind.
- **Verified against a `ddev` shim and unit tests only**: levels 3 and 4, the media `copy`
  and `proxy` modes, and the Drupal and Laravel change providers.
- Not built yet: level 4 fresh installs, `--db subset`, anonymise-on-clone, `wt db rollback`,
  React `--pair`, WordPress multisite, a Liquibase provider, an MCP wrapper.

That first real-DDEV run is worth being blunt about: it found eight bugs, and three of them
could not have been caught by the shim — a fake `ddev delete` has no database volume to
drop, and a fake `ddev exec` has no shell to mangle backticks. The warm pool handed over an
empty database, `wt db apply` could never replay a changeset, and `wt db export` wrote whole
tables including `mailserver_pass`. All are fixed and covered by regressions. Treat
"shim-verified" in the list above as weaker evidence than it sounds.

Bug reports from real projects are the most useful thing you can contribute right now.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — why it works this way: the DDEV facts it leans on, the
  level model, adapters, routing, DB change tracking, prior art.
- [`CLAUDE.md`](CLAUDE.md) — conventions for anyone (human or agent) changing this repo.

## Development

```bash
cd cli
npm install
npm run typecheck
npm test              # unit tests
npm run test:smoke    # end-to-end against a fake `ddev` on PATH — no Docker needed
npm run test:all
```

`test/smoke.sh` scaffolds a throwaway WordPress repo in a temp directory, puts a shim `ddev` on
`PATH`, drives `new → ls → url → context → pool fill → pool claim → destroy`, and asserts on the
artefacts: the manifest, the generated `.ddev/config.wt.local.yaml`, the uploads symlink, git
worktree state and the log of `ddev` calls. `KEEP=1 npm run test:smoke` keeps the scratch
directory. Anything touching `src/core/planner.ts` or a command should arrive with a smoke
assertion or a unit test, and `wt --json` output shapes must not change silently — agents depend
on them.

## License

MIT — see [LICENSE](LICENSE).
