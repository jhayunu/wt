# `wt` — Worktree Environments for AI Agents

Architecture for a CLI that gives every git worktree its own runnable environment (DDEV-based) for WordPress, Laravel and React projects, sized to the complexity of the task an AI agent is working on.

Status: v0.2 · see the maturity note in [`README.md`](README.md#maturity) for what is verified
against real DDEV and what is still only exercised against a test shim.

---

## 1. Problem

AI coding agents (Claude Code, Cursor, etc.) work best when several of them can run in parallel, each on its own branch, each able to *run* the app — not just edit files. Git worktrees solve the filesystem half of that. They do not solve the runtime half:

- All worktrees share one `.ddev/config.yaml`, so they collide on the DDEV project name, hostname and database.
- WordPress bakes the site URL into the database (`siteurl`, `home`, serialized option blobs, post content). Two worktrees with different hostnames cannot share one database.
- Laravel migrations mutate schema. An agent testing a migration on a shared DB breaks every other worktree.
- Media/uploads (`wp-content/uploads`, `storage/app/public`) are large, gitignored, and should not be copied per worktree.
- Spinning up a full stack for a one-line CSS fix is wasteful; spinning up nothing for a schema change is dangerous.

The tool has to pick the *right* amount of isolation for the job, make it one command for an agent to call, and clean up after itself.

## 2. Goals and non-goals

Goals

- One command creates a worktree **and** a ready-to-use environment: `wt new feat/checkout --level=full`.
- Isolation level is selectable and, by default, inferred from the task/framework.
- Works with the DDEV projects you already have; no custom Docker stack.
- Safe for unattended agents: idempotent, non-interactive, machine-readable output (`--json`), hard limits on concurrent envs.
- Framework adapters for WordPress, Laravel, React (and "static/none" for docs-only changes).
- Cheap teardown and garbage collection of forgotten worktrees.

Non-goals (v1)

- Remote/cloud environments. Local Docker only.
- Replacing DDEV. `wt` orchestrates `ddev`, `git`, `wp`, `artisan`, `npm`.
- Production deploys.

## 3. Key DDEV facts the design leans on

These are verified against current DDEV docs and are the reason DDEV is a good fit rather than an obstacle.

1. **Per-worktree project name.** `wt` writes `name: <worktree>` into the worktree's `.ddev/config.wt.local.yaml`; DDEV merges `config.*.yaml` over `config.yaml`, so that wins even when the repo pins its own `name:` (verified on DDEV v1.25.1 with `ddev utility configyaml`). A worktree at `…/.wt/worktrees/feat-checkout/` becomes project `feat-checkout` → `https://feat-checkout.ddev.site`, with its own `db` container. (Omitting `name:` altogether also works — DDEV then derives it from the directory, the pattern it documents for worktrees — but requiring that of every repo was a needless barrier: it renames the main project and moves its URL.)
2. **Override files.** DDEV merges `.ddev/config.*.yaml` in lexicographic order; `config.local.yaml` and `config.*.local.yaml` are gitignored by default. `wt` writes all per-worktree settings to `.ddev/config.wt.local.yaml` and never touches the committed config.
3. **One router, many projects.** All running projects share the DDEV router on 80/443 and get unique `*.ddev.site` hostnames. No port juggling.
4. **Database tooling.** `ddev snapshot` / `snapshot restore`, `ddev export-db` / `import-db`, and `ddev wp` / `ddev artisan` / `ddev exec` cover cloning and URL rewriting without custom SQL. Snapshots are gzipped files under a project's `.ddev/db_snapshots`, and may be moved between projects as long as the `-<dbtype>_<version>.gz` suffix is unchanged — which is what `stepDbClone` relies on, copying the file verbatim between two projects that share one `.ddev/config.yaml`. Note that `ddev snapshot` accepts `-y` but `ddev snapshot restore` does not (checked on v1.25.1).
5. **Hooks.** `hooks.post-start` in the override file lets `wt` run `wp search-replace` or `artisan migrate` automatically on every `ddev start`.
6. **Upload dirs.** `upload_dirs:` tells DDEV where media lives (exposed as `DDEV_FILES_DIRS`), which `wt` uses to decide what to symlink.

## 4. Isolation levels

Levels are cumulative. Each adds cost (time, RAM, disk) and removes a class of interference.

| Level | Name | Git | Runtime | Database | Media | Typical use |
|---|---|---|---|---|---|---|
| 0 | `none` | worktree only | none | — | — | docs, config, code review |
| 1 | `shared` | worktree | no server of its own; **borrows main's** web container via `wt npm|composer|artisan|wp <name> …` (→ `ddev exec --dir`) | main's DB (read-only by convention) | main's | React builds/tests, lint, unit tests, composer/npm |
| 2 | `app` | worktree | **own DDEV project** (web container, hostname) | own DB container, **schema + data cloned from main** via snapshot | **symlinked** to main | the default for features; safe for migrations |
| 3 | `full` | worktree | own DDEV project | own DB, cloned | **copied** (or cloned subset) | tasks that write/transform media, import pipelines, anything that must not leak back |
| 4 | `clean` | worktree | own DDEV project | own DB, **fresh install / seeders only** | empty | greenfield features, migration-from-zero tests, reproducible CI-like runs |

Notes per level:

- **Level 1 is deliberately thin.** DDEV cannot serve two docroots from one project, so "shared runtime" really means "borrow main's PHP/Node toolchain". It exists so agents can run the test suite of a worktree without paying for containers: `wt exec -- vendor/bin/phpunit` runs `ddev exec` in the main project with `--workdir` pointed at the worktree path (the worktree must live **inside** main's mounted tree or in a path mounted via `docker-compose.wt.yaml`; see §7.4).
- **Level 2 is the workhorse.** DB clone via `ddev snapshot` on main → `ddev snapshot restore` in the worktree project (same DB engine/version, binary restore, fast). Media symlinked. Safe for Laravel migrations because they run on the clone.
- **Level 3/4** exist because symlinked media is shared state: if the task resizes images, regenerates thumbnails, or runs an importer, it must not write into main's uploads.

## 5. Choosing the level automatically

The agent can pass `--level` explicitly. When it doesn't, `wt` scores the request:

```
level = max(
  framework_floor,          # wordpress → 2 (domain in DB), laravel → 1, react → 1 (ddev npm in main)
  task_hints,               # --task "add migration for orders" → 2 ; "import products" → 3
  diff_signals,             # after first commit: touches database/migrations/** → ≥2 ;
                            #                  touches wp-content/uploads or storage/** → 3
  profile_override          # .wt.yml: min_level / max_level
)
```

Task hints are keyword rules shipped in `wt` and extendable in `.wt.yml` (`hints: { "migration|schema|seeder": 2, "import|media|thumbnail|upload": 3 }`). Agents usually know what they're about to do, so `--task "…"` is the cheapest signal and should be encouraged in the agent's system prompt / skill.

`wt promote <name> --level=3` upgrades an existing worktree in place (e.g. level 2 → 3 replaces the symlink with a copy) so a wrong guess is recoverable without recreating.

## 6. Framework adapters

One interface, three implementations. Adapter is detected from the repo (`wp-config.php`/`wp-content` → wordpress; `artisan` → laravel; `package.json` with react/vite/next → react; any combination → composite, e.g. Laravel + React SPA in the same repo).

```ts
interface Adapter {
  detect(repo): boolean
  floorLevel(): Level
  ddevOverrides(ctx): YAML          // merged into config.wt.local.yaml
  mediaPaths(): string[]            // what to symlink/copy
  dbClone(ctx): Promise<void>       // snapshot/restore + fixups
  postStart(ctx): Promise<void>     // URL rewrite, caches, env
  envFiles(ctx): Record<path, string>
  healthCheck(ctx): Promise<Status> // HTTP 200 on primary URL, db ping
  teardown(ctx): Promise<void>
}
```

### 6.1 WordPress

- Floor level **2** — never share a DB across hostnames.
- `ddevOverrides`: `type: wordpress`, `upload_dirs: [wp-content/uploads]`, `hooks.post-start` → `wp search-replace`.
- `dbClone`: `ddev snapshot --name wt-<ts>` on main → copy snapshot dir → `ddev snapshot restore`. Then:
  ```
  wp search-replace 'https://main.ddev.site' 'https://feat-checkout.ddev.site' --all-tables --precise --recurse-objects
  wp option update blog_public 0
  wp cache flush ; wp rewrite flush
  ```
  Multisite: also rewrite `wp_blogs.domain` / `wp_site.domain` and pass `--network`.
- `envFiles`: generate `wp-config-wt.php` (gitignored) with `WP_HOME`/`WP_SITEURL` constants **and** the DDEV-provided DB creds, included from `wp-config.php` via an `if (file_exists(…))` shim committed once. This is belt-and-braces against plugins that hardcode URLs.
- `mediaPaths`: `wp-content/uploads` (+ `wp-content/cache`, `wp-content/uploads/…/private` excluded from copy).
- Plugin/theme development repos (repo *is* a plugin, not the site): adapter `wordpress-plugin` — worktree env is a **site template** (`.wt/site-template/`) into which the worktree is symlinked as a plugin. Same DB rules apply.

### 6.2 Laravel

- Floor level **1**; escalates to 2 on migration/seeder hints or paths.
- `ddevOverrides`: `type: laravel`, `upload_dirs: [storage/app/public]`, `hooks.post-start` → `artisan migrate --force` (only when `--migrate` or level ≥ 2 and `.wt.yml: laravel.auto_migrate: true`), `artisan storage:link`, `artisan optimize:clear`.
- `envFiles`: write `.env` from main's `.env` with `APP_URL`, `ASSET_URL`, `DB_*` (DDEV defaults `db/db/db`), `CACHE_PREFIX=<name>`, `REDIS_PREFIX=<name>`, `QUEUE_CONNECTION` (see below), `MAIL_MAILER=smtp` → Mailpit. `APP_KEY` copied so encrypted data in the cloned DB still decrypts.
- **Queues / scheduler:** each level ≥ 2 worktree runs its own `queue:work` via a DDEV `web_extra_daemons` entry, and shares nothing. Redis is either per-project (`ddev add-on get ddev/ddev-redis`) or a shared Redis with key prefixes — per-project is the default because Horizon/Scout state leaks otherwise.
- **Migrations safety:** before `artisan migrate`, `wt` takes `ddev snapshot --name pre-migrate` in the worktree project so `wt db rollback` is one command. `wt db diff` runs `artisan schema:dump` in both projects and diffs the SQL for the PR description.
- **Large tasks:** `--db=fresh` (level 4) runs `migrate:fresh --seed`; `--db=subset` (planned) clones schema + last-N rows of big tables via `mysqldump --where`.

### 6.3 React (Vite / Next / CRA)

- **All tooling runs inside DDEV** (`ddev npm`, `ddev npx`, `ddev node`); no host Node is assumed. Floor level **1**: builds, tests and lint run in main's web container via `ddev exec --dir /var/www/html/.wt/worktrees/<name>`. Level **2** gives the worktree its own DDEV project (`webserver_type: generic`) with Vite as a `web_extra_daemons` entry exposed through the router, so the app is reachable at `https://feat-x.ddev.site` with HMR and no host ports.
- Important: a level 0/1 worktree still contains the committed `.ddev/config.yaml`, so running `ddev` *from inside it* would create a new project. `wt` therefore always routes level 0/1 commands through main (`wt npm <name> …`), and the skill tells agents never to call `ddev` directly there.
- `envFiles`: `.env.local` with `VITE_API_URL=https://<paired-backend>.ddev.site`.
- **Pairing:** `wt new feat/x --pair=backend-repo` creates a matching worktree in the backend repo (same branch name if it exists, else main) and wires the URLs both ways. This is how a full-stack feature gets one coherent sandbox.
- `node_modules`: hardlink-clone from main (`cp -al`) or pnpm store → install is seconds, not minutes.

### 6.4 Composite (Laravel + React in one repo)

Run both adapters; DDEV serves Laravel, Vite runs inside the web container via `web_extra_daemons` + `web_extra_exposed_ports` so HMR works on the `ddev.site` hostname.

## 7. Data & media strategy

### 7.1 Database

| Strategy | How | When |
|---|---|---|
| `snapshot` (default) | `ddev snapshot` main → restore in worktree | same engine/version, fastest, binary-level |
| `dump` | `ddev export-db` → `ddev import-db` | cross-version, or main isn't running |
| `fresh` | installer / `migrate:fresh --seed` | level 4 |
| `subset` | schema + partial rows | planned; big DBs |

Naming: DDEV gives each project its own `db` container, so there is no cross-project name clash. Inside the container the DB is always `db` — no need to rename databases.

Protections: `wt` refuses to run destructive DB ops against the project marked `main` in `.wt.yml` unless `--i-know`. Every worktree project gets a `pre-task` snapshot at creation and before `wt db migrate`.

### 7.2 Media / storage

| Mode | Mechanism | Trade-off |
|---|---|---|
| `symlink` (level 2 default) | `ln -s ../../main/wp-content/uploads wp-content/uploads` | zero disk, instant; writes leak into main |
| `copy` (level 3) | `rsync -a --link-dest` (hardlinks where FS allows) or `cp -c` on APFS (clone, copy-on-write) | isolated; on APFS nearly free until files change |
| `proxy` (implemented) | nginx snippet in `.ddev/nginx/wt-media.conf`: `try_files $uri @main` → `proxy_pass https://ddev-router` with `Host: main.ddev.site` | isolated writes, zero copy, no symlink-outside-worktree issues on macOS/Windows; reads of main's media cost one hop through the router |
| `overlay` (planned) | bind-mount uploads read-only + writable upper dir via `docker-compose.wt.yaml` | isolated + zero copy, but Linux-only overlayfs inside container |
| `none` (level 4) | empty dir | clean |

Docker Desktop on macOS: symlinks inside the mounted project resolve on the host side, so a symlink to a sibling directory outside the worktree works **only if that path is also shared with Docker** (it is, when both live under the same DDEV-mounted parent). The recommended layout (§8) keeps main and all worktrees under one parent to guarantee this.

WordPress also needs uploads URL coherence: after search-replace, `https://feat-x.ddev.site/wp-content/uploads/...` resolves through the worktree's own docroot → symlink → main's files. Works transparently.

### 7.3 Secrets / env

`.env`, `wp-config-wt.php`, `.ddev/config.wt.local.yaml` are **generated, gitignored, and recorded in `.wt/manifest.json`** so `wt destroy` removes exactly what it created. Template values come from main's files; overrides from `.wt.yml`.

### 7.4 Worktree placement

```
~/Development/sites/
└── myshop/                  ← main checkout, DDEV project "myshop"
    ├── .ddev/
    ├── .wt.yml               ← repo-level policy (committed)
    └── .wt/                  ← state (gitignored)
        ├── manifest.json
        └── worktrees/
            ├── feat-checkout/   ← git worktree, DDEV project "feat-checkout"
            └── fix-header/
```

Placing worktrees *inside* main's tree (gitignored `.wt/`) means they are automatically shared with Docker, sibling symlinks resolve, and `ddev exec` in main can reach them (level 1). The directory name is the DDEV project name, so `wt` slugifies branch names (`feat/checkout` → `feat-checkout`) and enforces DNS-safe, ≤ 63 chars, unique across `ddev list`.

## 7.5 Networking: zero-disturbance routing

Goal: creating or destroying one agent's environment must not restart Docker, the router, or any other agent's containers.

**DNS.** No host-file edits are needed in the default setup. `*.ddev.site` is a public wildcard record that resolves to `127.0.0.1`, so any new name (`feat-checkout.ddev.site`) resolves the instant it is chosen. The host never has to be touched, and nothing is restarted. `wt` keeps the default TLD for this reason.

Fallbacks, in order of preference, when the machine is offline or a custom TLD is wanted:

1. A local wildcard resolver — `dnsmasq` on macOS (`address=/.ddev.site/127.0.0.1` + `/etc/resolver/ddev.site`) or Acrylic DNS Proxy on Windows. Both give true `*.tld → 127.0.0.1` behaviour and are a one-time setup. `wt doctor` detects and offers to install this.
2. `use_dns_when_possible: false` in DDEV, which makes DDEV write one `/etc/hosts` line per hostname on `ddev start` (requires sudo, and hosts files on macOS/Windows do not support wildcards). Works, but each new worktree touches a system file — acceptable, not ideal.

**Router.** DDEV runs a single shared Traefik container (`ddev-router`). Each project's routes live in their own file (`config/<project>.yaml` inside the router, generated from the project's `.ddev/traefik/`), and Traefik's file provider hot-reloads them. Starting project B therefore adds a file and a route; project A's containers and connections are untouched. Stopping or deleting B removes its file. The only events that restart the router are a DDEV version upgrade, a change to the router's own ports/config, or `ddev poweroff` — `wt` never calls `poweroff` and `wt doctor` warns before a DDEV upgrade while worktrees are running.

**TLS.** mkcert certificates are generated per project on `ddev start` and loaded through the same per-project Traefik file, so HTTPS for a new hostname also needs no global action. Wildcard `additional_hostnames` (`"*.feat-checkout"`) are supported for multisite.

**Ports.** Web/DB containers bind no host ports except the router's 80/443 (and optional per-project `host_db_port`, which `wt` leaves unset to avoid collisions). React dev servers that run on the host use the `wt` port registry; when they are run inside the web container via `web_extra_exposed_ports` they are reached through the router on the project hostname instead, which is the recommended mode for the same zero-collision reason.

Net effect: `wt new` on one worktree is a pure addition — new containers, one new router config file, one new cert — and every other agent's environment keeps its connections, PHP-FPM workers, queue workers and HMR sockets alive.

## 7.6 Versioning database changes (the "DB has no git" problem)

Code in a worktree is versioned by git; what the agent does to the worktree's **database** is not. For Laravel, schema changes are already code (migrations), but seed data and content are not. For WordPress, almost everything of value — options, menus, ACF field groups, block patterns, posts — lives in the DB and has no representation in the branch. A reviewer who checks out the branch sees the code but not the content that made it work.

`wt` treats this as a first-class concern through a pluggable **change-tracking port**. The CLI never hard-codes one tool.

```ts
interface DbChangeProvider {
  id: string                                   // "snapshot-diff" | "laravel-migrations" | "liquibase" | "wp-changeset" | ...
  detect(repo): boolean
  baseline(ctx): Promise<void>                 // record the state at worktree creation
  diff(ctx): Promise<ChangeSet>                // what changed since baseline
  export(ctx, cs: ChangeSet, dir): Promise<string[]>   // write versionable files into the worktree
  apply(ctx, dir): Promise<void>               // replay a committed changeset onto another env
  status(ctx): Promise<{applied: string[], pending: string[]}>
}
```

Every level ≥ 2 worktree carries a `db/changes/` directory (committed, path configurable) and a `.wt/db-baseline` marker. `wt db diff` shows the delta, `wt db export` writes it into `db/changes/<timestamp>-<slug>/`, and `wt db apply` replays it — on main after merge, or on another agent's worktree that needs the same content.

Providers shipped or planned:

| Provider | Tracks | Output format | Notes |
|---|---|---|---|
| `snapshot-diff` (default, agnostic) | schema + rows of whitelisted tables | `schema.sql` (DDL diff) + `data/<table>.sql` (`REPLACE INTO`, **only the rows that differ**) | Uses `mysqldump --no-data` / `--skip-triggers` on baseline and current, diffs with an embedded SQL-aware differ. Works for any DDEV DB. Row diffs only for tables listed in `.wt.yml: db.track_tables`, minus anything matched by `db.deny_rows`. Deletions are reported in the file header but not exported — expressing them needs the primary key, which this provider does not introspect. |
| `laravel-migrations` | schema (+ seeders) | nothing new — migrations are the changeset | `diff` = `artisan migrate:status` against baseline; `export` = no-op, but warns if schema drifted without a migration (agent edited the DB by hand). |
| `wp-changeset` | WordPress content | `options.json` (selected `wp_options`), `posts.wxr` (WXR export of posts/pages/CPTs changed since baseline, by `post_modified_gmt`), `acf.json` (ACF local JSON if present), `menus.json` | Built on WP-CLI. Replay uses `wp option update`, `wp import`, ACF sync. Hostname-agnostic because export rewrites URLs to a placeholder token and `apply` substitutes the target's URL. |
| `liquibase` | schema (+ data via `diff-changelog --diff-types=data`) | Liquibase changelog (XML/YAML/SQL) | Runs in a `liquibase/liquibase` container on the DDEV network against `db`. Good fit for teams that already use it; supports `rollback`. |
| `flyway`, `atlas`, `sqitch` | schema | their native formats | same container pattern; added when needed |

Selection: `.wt.yml: db.change_provider: auto | snapshot-diff | laravel-migrations | wp-changeset | liquibase`. `auto` picks `laravel-migrations` for Laravel, `wp-changeset` + `snapshot-diff` (schema only) for WordPress, `snapshot-diff` otherwise. Multiple providers can be stacked (`[laravel-migrations, snapshot-diff]`) so schema is tracked by migrations and seed content by snapshot-diff.

Workflow for an agent:

1. `wt new feat/pricing --task "add pricing table + sample content"` → baseline recorded.
2. Agent works; content is created in its own DB.
3. Before opening a PR: `wt db export` → files appear under `db/changes/…`, committed with the code.
4. Reviewer or main: `wt db apply` (or CI) replays them. `wt db diff` after apply should be empty — that is the acceptance check.

Guard rails: `wt db export` refuses to export tables with secrets unless whitelisted (`wp_users`, `wp_usermeta`, `personal_access_tokens`, `sessions` are denied by default); URLs and absolute paths are tokenised (`{{WT_URL}}`, `{{WT_ROOT}}`) on export and substituted on apply; exports are deterministic (sorted keys, stable ordering) so git diffs stay readable.

Why not only Liquibase: it is excellent at schema and acceptable at data, but it does not understand WordPress serialised PHP or WXR, and it requires Java. Keeping it behind the port lets teams choose it without making it a dependency for everyone.

## 8. CLI surface

```
wt new <branch> [--from main] [--level 0-4] [--task "..."] [--db snapshot|dump|fresh]
                 [--media symlink|copy|none] [--pair <repo>] [--no-start] [--json]
wt ls [--json]                         # worktrees, level, URL, status, age, disk
wt url <name>                          # https://feat-checkout.ddev.site
wt exec <name> -- <cmd>                # ddev exec in that project (level≥2) or main (level 0/1)
wt npm|npx|pnpm|yarn|node|composer|artisan|wp|php|mysql <name> [args]   # ddev <tool> passthroughs, same routing
wt up / wt down <name>                 # ddev start/stop
wt promote <name> --level N            # raise isolation in place
wt db snapshot|restore|reset <name>
wt db diff|export|apply|status <name>  # change tracking via the DbChangeProvider port (§7.6)
wt sync <name> [--db] [--media]        # refresh clone from main
wt doctor [<name>]                     # health: DNS, router, DB, URLs in DB, disk
wt destroy <name> [--keep-branch] [--force]
wt gc [--older-than 7d] [--merged]     # remove stale/merged worktrees + their DDEV projects
wt hook claude|cursor                  # print/install agent integration (skill, hooks)
```

Design rules for agent-friendliness: never prompt (fail with exit code + JSON error instead); `--json` everywhere; every command prints the primary URL last on success; exit codes are stable (`2` = name clash, `3` = main not running, `4` = limit reached …).

## 9. Configuration

`.wt.yml` (committed, per repo):

```yaml
main: myshop                   # DDEV project name of the canonical checkout
framework: auto                # wordpress | laravel | react | composite
min_level: 2                   # WordPress repos set 2
max_concurrent: 4              # refuse `wt new` beyond this
defaults:
  db: snapshot
  media: symlink
db:
  change_provider: auto        # auto | snapshot-diff | laravel-migrations | wp-changeset | liquibase
  changes_dir: db/changes
  track_tables: [wp_options, wp_posts, wp_postmeta, wp_terms, wp_term_taxonomy, wp_term_relationships]
  deny_tables: [wp_users, wp_usermeta, sessions, personal_access_tokens]
  deny_rows:                   # per-row deny for key/value tables: <table>.<column>
    wp_options.option_name: [cron, recovery_keys, mailserver_pass, "_transient_%", "_site_transient_%"]
hints:
  "migration|schema|seeder": 2
  "import|media|thumbnail|upload|resize": 3
laravel:
  auto_migrate: true
  queue: per-project           # per-project | shared-prefixed | none
wordpress:
  search_replace_extra: ["//cdn.example.com"]
  exclude_tables: ["wp_actionscheduler_logs"]
react:
  pair_with: ../myshop-api
```

`~/.wt/config.yml` (global): port range, disk quota, default `--level`, telemetry off.

## 10. Internals

- **Language:** TypeScript on Node (zx/execa for process control) — same toolchain as the React projects, easy to ship as an npm bin, trivially wrappable as an MCP server later. Go is the alternative if a single static binary matters more.
- **State:** `.wt/manifest.json` per repo (worktrees, level, created files, snapshots) + `~/.wt/registry.json` (global names/ports). Everything else is derivable from `git worktree list --porcelain` and `ddev list --json-output`; the manifest is a cache plus an undo log.
- **Locking:** a file lock around `wt new`/`destroy` so two agents can't race on names or snapshots.
- **Plan/apply:** `wt new --dry-run` prints the plan (files to write, commands to run). Internally every command is a list of steps with `up()`/`down()`, executed with rollback on failure — half-created environments are the worst failure mode for agents.
- **Observability:** `wt ls` shows RAM/disk per project (from `docker stats` / `du`), so an agent or human can see when to `gc`.

## 11. Agent integration

- Ship a Claude Code **skill** (`wt` skill) whose instructions say: start every task with `wt new <branch> --task "<summary>" --json`, read `url`, run tests via `wt exec`, finish with `wt destroy` (or leave for review with `--keep`).
- Claude Code **hooks**: `SessionStart` → `wt doctor`; `Stop` → remind to destroy or `gc`.
- Make `wt` output include `next_steps` hints in JSON so agents self-correct (`"db was cloned at snapshot X; run 'wt db diff' before opening a PR"`).
- MCP wrapper (phase 4) simply maps each subcommand to a tool; no new logic.

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Docker RAM exhaustion with many WP/Laravel projects | `max_concurrent`, `wt gc`, auto `ddev stop` of idle projects (no HTTP hits in N hours) |
| Snapshot incompatibility across DB versions | pin `database:` in committed config; fall back to dump |
| Symlinked media written to by mistake | level-2 warning in `wt doctor`; `--media=copy` suggestion when task hints mention media |
| Hardcoded URLs missed by search-replace | `wp-config-wt.php` constants + `wt doctor` greps DB for main hostname |
| Branch names not DNS-safe / too long | slugify + hash suffix; store mapping in manifest |
| Disk growth from snapshots | snapshots live inside each worktree project; `destroy` removes them; `gc` prunes by age |

## 13. Roadmap

**Phase 1 — Core (1–2 weeks)**
`wt new/ls/destroy/exec/url`, levels 0 and 2, WordPress + Laravel adapters, snapshot DB clone, symlink media, `.wt.yml`, `--json`, rollback on failure.

**Phase 2 — Safety & speed (done in v0.2)**
`wt promote` (in-place level/media changes), ownership leases + `.wt.yml: policy`, `wt context` injected on every prompt by the plugin, DDL differ producing real `ALTER`s + `wt_changesets` ledger (idempotent apply), `media: proxy`, warm pool (`wt pool`), ddev tool passthroughs (`wt npm|artisan|wp … <name>`), APFS-clone media copy.

**Phase 3 — Data depth & pairing**
Level 4 fresh installs, `--db subset`, anonymise-on-clone, `wt db rollback` (pre-migrate snapshot restore), React `--pair`, multisite WordPress, plugin-repo mode (site template), Liquibase/Atlas providers, bare-clone layout option (`wt init --layout bare`, no privileged main checkout; level-1 routing then targets a configured `anchor` worktree).

**Phase 4 — Agent polish**
Claude Code skill + hooks, MCP wrapper, `wt doctor` heuristics (URL leakage, idle detection), overlay media mode, DB subsetting.

## 14. Prior art: workspace-manager

[marklabrecque-ab/workspace-manager](https://github.com/marklabrecque-ab/workspace-manager) (Go) solves the same core problem for Drupal/WordPress with DDEV and independently arrived at the same mechanics: one DDEV project per worktree via a config override, relative symlinks for shared files, `ddev delete -O -y` + `git worktree remove --force` on failure. Differences and what `wt` took from it:

| Topic | workspace-manager | wt |
|---|---|---|
| Layout | bare clone: `.bare/`, `.git` pointer, `spaces/<wt>`, `db/`, `files/` | main checkout + `.wt/worktrees/`; bare layout is a phase-3 option (`wt init --layout bare`) |
| DDEV name | writes `name: <id>-<orig>` to `config.local.yaml` | **adopted**: writes `name: <worktree>` to `config.wt.local.yaml`, so the repo may keep its own `name:` |
| WordPress URLs | none (WP worktrees would keep main's URL) | `wp search-replace` hooks + `wp-config-wt.php` constants |
| DB seed | `db/db.sql.gz` via `ddev pull prod`; safety export before import | **adopted** as `db: seedfile` + `wt db seed`; plus snapshot/dump from a running main |
| Drupal | files dir, `settings.ddev.php` host, `drush cr/cim/deploy:hook` | **adopted** as the Drupal adapter |
| Rename hygiene | removes `.ddev/traefik` after renaming a project | **adopted** in pool claim (it was a latent bug) |
| Failure policy | non-critical steps warn and continue | **adopted** as `Step.optional` (media sync) |
| Cleanup | `docker builder prune -f` on remove | **adopted** in `wt gc` |
| Interaction | confirmation prompts, interactive import picker | never prompts; `--json`, exit codes, policy |
| Not present there | — | isolation levels, change tracking, ownership/leases, pool, proxy media, agent hooks |

## 15. Open questions

1. ~~Does main's DDEV project need to be running to clone?~~ Resolved: `db: seedfile` (+ `wt db seed`, optionally via `ddev pull`) removes the dependency; `snapshot`/`dump` still need main up.
2. Multisite WordPress: subdomain installs need wildcard `additional_hostnames: ["*.feat-checkout"]`. DDEV supports the wildcard; confirm certificate behaviour for second-level wildcards in your mkcert/DDEV version.
3. Should level 1 exist at all, or is "level 0 + run tests in main via `ddev exec`" clearer as a plain `wt exec --in-main`?
4. Storage backends beyond local disk (S3-compatible/MinIO in Laravel): per-worktree bucket prefix vs. shared bucket.
