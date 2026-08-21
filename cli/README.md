# wt — per-worktree DDEV environments for AI agents

One command gives a git worktree its own running environment (hostname, containers, database, media), sized to the task. Built on DDEV; supports WordPress, Drupal, Laravel and React. Design: see `../ARCHITECTURE.md`.

## Install

**As a Claude Code plugin (recommended for agents)**

```
/plugin marketplace add jhayar/GitWorktrees      # or: /plugin marketplace add /path/to/GitWorktrees
/plugin install wt@gitworktrees
```

The plugin ships the `wt-worktree-env` skill, a `/wt <branch> "<task>"` command, a SessionStart hook that reports environment health, and a Stop hook that reminds about live worktrees. It runs the CLI from `${CLAUDE_PLUGIN_ROOT}/bin/wt` (builds itself on first use) or uses a global `wt` when present.

**As a global CLI**

```bash
npm install -g @jhayar/wt        # or: curl -fsSL …/cli/install.sh | sh
wt skill install                 # copies the skill to ~/.claude/skills/wt (optional if plugin installed)
```

**From a checkout**

```bash
cd cli && npm install && npm run build && npm link
```

## One-time repo setup

```bash
wt clone git@github.com:org/myshop.git   # new machine: clone + init + ddev start (+ --seed)
# or, for an existing checkout:
cd ~/sites/myshop          # your canonical checkout (DDEV project "myshop")
wt init                    # writes .wt.yml, .gitignore entries, prints follow-ups
# follow the printed ACTION lines: remove `name:` from .ddev/config.yaml (DDEV then names
# projects after the directory — which is exactly what worktrees need), add the
# wp-config-wt.php include for WordPress.
ddev start
```

## Daily use (what an agent runs)

```bash
wt new feat/checkout --task "add checkout page with new orders table"
#   level 2 (app): wordpress floor=2
#   plan: worktree → config → media symlink → db snapshot → ddev start → baseline
#   https://feat-checkout.ddev.site

wt wp feat-checkout plugin list          # == ddev wp, inside that worktree's containers
wt artisan feat-checkout migrate:status  # also: wt npm | npx | pnpm | composer | php | mysql | node
wt exec feat-checkout -- <any command>   # generic
wt db diff feat-checkout          # what changed in the DB since creation
wt db export feat-checkout        # write it to db/changes/<ts>-feat-checkout/ → commit with the code
wt destroy feat-checkout          # containers, worktree, branch, generated files
```

```bash
wt promote feat-checkout --level 3        # in place: symlink → copy; also --media proxy|symlink|copy|none
wt context                                 # where am I? (auto-injected into Claude Code prompts by the plugin)
wt pool fill 2 && wt new feat/x --task …   # claims a pre-built env in seconds instead of cloning
wt db apply feat-checkout                  # idempotent: a ledger table records what was applied
```

Every command accepts `--json` (put it before the subcommand: `wt --json new …`) and `--dry-run`. Exit codes: 2 name clash · 3 main not running · 4 concurrency limit · 5 not found · 6 ddev missing.

## Isolation levels

| level | what you get | default for |
|---|---|---|
| 0 `none` | worktree only | docs, pure code review |
| 1 `shared` | worktree + `wt npm/composer/artisan/…` run in **main's** web container (`ddev exec --dir`) | React, Laravel without migrations |
| 2 `app` | own DDEV project, DB cloned via snapshot, media symlinked | WordPress always; Laravel with migrations |
| 3 `full` | as 2 but media copied | tasks that write media |
| 4 `clean` | own project, fresh DB, empty media | greenfield / reproducibility |

Level is inferred from framework floor + `--task` keywords (`.wt.yml: hints`) + `--level`, clamped by `min_level`/`max_level` and `policy.allow_levels`. `wt promote` changes level/media in place (0/1→2+, 2↔3, any media mode swap); level 4 and demotion below 2 require recreate.

## DB strategies

`snapshot` (default; binary snapshot of main, needs main running) · `dump` (export/import, cross-version) · `seedfile` (`db/seed.sql.gz` refreshed by `wt db seed`, works with main stopped, `seed.refresh: ddev-pull` pulls from your hosting provider first) · `fresh` · `none`.

## Media modes

`symlink` (default, zero-copy, writes leak to main) · `copy` (APFS clone on macOS via `cp -c`, isolated) · `proxy` (nginx `try_files` → falls back to main through the DDEV router; zero filesystem coupling, writes stay local) · `none`.

## Ownership & policy

Each worktree records an `owner` (`WT_OWNER` env, else `claude:<session>` under Claude Code, else `user@host`) and a lease (`policy.lease_hours`, default 24h). Destroying or promoting someone else's worktree inside its lease needs `--force`. `.wt.yml: policy` also has `allow_levels`, `require_task`, `allow_destroy: own|any`. Policy violations exit with code 8 and a hint.

## Warm pool

`pool.size: N` in `.wt.yml` + `wt pool fill` pre-builds N stopped level-2 environments on throwaway `wt/pool-*` branches. `wt new` claims one when level/db/media match: rename dir (= DDEV project name), switch branch, re-run URL fixups from the pool hostname. `--no-pool` / `--pool` override; `wt pool drain` removes them.

## Everything runs in DDEV

No host Node/PHP is assumed. `wt <tool> <name> …` maps to `ddev <tool>` for level ≥ 2 worktrees (own project) and to `ddev exec --dir /var/www/html/.wt/worktrees/<name> <tool>` in main's container for level 0/1. Never run `ddev` directly inside a level 0/1 worktree: the checkout carries `.ddev/config.yaml`, so DDEV would spin up a new project named after the directory.

## Layout

```
myshop/                      DDEV project "myshop"
├── .wt.yml                  committed policy
├── .wt/                     gitignored state: manifest.json, lock, baseline/, worktrees/
│   └── worktrees/feat-checkout/    DDEV project "feat-checkout"
│       ├── .ddev/config.wt.local.yaml   generated, gitignored by DDEV
│       ├── wp-config-wt.php | .env      generated
│       ├── wp-content/uploads -> ../../../../wp-content/uploads
│       └── db/changes/                  committed DB changesets
```

## Database change tracking

DB edits have no git. `wt` records a baseline at creation and exposes `diff / export / apply / status` through a pluggable `DbChangeProvider` (`src/providers/`):

- `snapshot-diff` — agnostic: real `ALTER/CREATE/DROP` statements from a CREATE TABLE differ (`providers/ddl-diff.ts`) + tracked-table row upserts
- ledger: `wt_changesets` table in each worktree DB records applied changesets → `wt db apply` is idempotent, `wt db status` is accurate
- `laravel-migrations` — migrations are the changeset; warns on drift
- `wp-changeset` — changed `wp_options` as JSON + WXR export of modified posts; URLs tokenised as `{{WT_URL}}`
- Liquibase / Flyway / Atlas — add one file implementing the interface and register it in `providers/index.ts`

## Source map

```
src/cli.ts               commander entry
src/core/types.ts        Level, RepoConfig, WorktreeRecord, Adapter, DbChangeProvider, Step
src/core/planner.ts      inferLevel(), planNew(), planDestroy()   ← the interesting part
src/core/engine.ts       applySteps(): run steps, roll back on failure
src/core/{git,ddev,proc,lock,config,context}.ts
src/adapters/{wordpress,drupal,laravel,react}.ts
src/providers/{snapshot-diff,laravel-migrations,wp-changeset}.ts
src/commands/{init,clone,new,promote,pool,context,tools,misc,db,skill}.ts
src/core/policy.ts       ownership leases + .wt.yml policy
src/providers/ddl-diff.ts, ledger.ts
skills/wt/SKILL.md       Claude Code skill telling agents how to use wt
commands/wt.md           /wt slash command
hooks/hooks.json, scripts/   SessionStart / Stop hooks
bin/wt                   wrapper used by the plugin (global wt → else local build)
.claude-plugin/plugin.json   plugin manifest (marketplace.json lives at repo root)
```

## Development

```bash
cd cli
npm install
npm run typecheck     # tsc --noEmit
npm test              # unit tests (node --test)
npm run test:smoke    # end-to-end against a fake `ddev` on PATH — no Docker needed
npm run test:all      # both
npm run build && npm link   # global `wt`
```

`test/smoke.sh` scaffolds a throwaway WordPress repo in a temp dir, puts a shim `ddev`
on `PATH`, then drives `new → ls → url → context → pool fill → pool claim → destroy` and
asserts on the artefacts (manifest, generated `.ddev/config.wt.local.yaml`, symlinked
uploads, git worktree state, the ddev call log). `KEEP=1 npm run test:smoke` keeps the
scratch directory for inspection. Anything that touches `core/planner.ts` or a command
should come with a smoke assertion or a unit test.

## Status

v0.2: levels 0–3 end-to-end incl. promote, ownership/policy, warm pool, media proxy, DDL differ + ledger, `wt context` + prompt hook, ddev tool passthroughs. All tested against a `ddev` shim and unit tests (`npm run test:all`); first real run should be on a throwaway WordPress site. Not yet: level 4 fresh installs, `subset` DB, anonymisation, React pairing, multisite, Liquibase provider, MCP wrapper.
