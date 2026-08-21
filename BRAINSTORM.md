# wt — feature brainstorm

Ideas beyond the v0.1 scaffold, grouped by theme. Each has a one-line "why", a rough size (S/M/L), and a note on where it plugs into the current design. Nothing here is committed; the point is to see the shape of the space before choosing phase 2.

Legend: **S** < 1 day · **M** 1–3 days · **L** a week+

---

## 1. Isolation & environment shapes

**Promote / demote in place (M).** `wt promote feat-x --level 3` swaps the media symlink for a copy, adds a Redis service, etc., without recreating. Needs a `Step` list per transition (2→3, 3→2, 1→2). Planner already models steps.

**Ephemeral "preview" mode (S).** `wt new --ttl 4h`: auto-`down` after idle, auto-`destroy` after TTL. Background sweeper = `wt gc --auto` in a launchd/cron entry that `wt init --daemon` installs.

**Warm pool (M).** Pre-create N stopped level-2 projects from main's snapshot (`wt pool fill 2`). `wt new` claims one, renames the worktree and re-runs URL fixups: creation drops from ~60s to ~5s. Good for agents that spin many short tasks.

**Per-worktree PHP/Node version (S).** `wt new --php 8.2 --node 20` writes `php_version`/`nodejs_version` into the override file. Lets an agent test an upgrade branch without touching main's config.

**Service add-ons per worktree (S).** `--with redis,elasticsearch,mailpit` → `ddev add-on get` inside the worktree project only. Config key `addons:` in `.wt.yml` for defaults per framework.

**Shared-service mode (M).** For heavy services (Elasticsearch, Typesense) run one shared container and give each worktree an index prefix — same pattern as the Redis key-prefix option. Trade memory for isolation explicitly.

**Headless / CI mode (M).** `wt new --ci` uses dump instead of snapshot, no router (ports only), no mkcert. Same CLI runs in GitHub Actions to reproduce an agent's environment for a PR check.

**Remote worktrees (L).** Same manifest, but the DDEV project lives on a remote Docker host (`DOCKER_HOST`) or a Coder/DevPod workspace. The planner is host-agnostic already; the media/symlink step and DNS would need a remote strategy.

## 2. Database

**DDL differ (M).** Today `snapshot-diff` exports the full schema when anything changed. Generate real `ALTER TABLE` statements (parse `SHOW CREATE TABLE` before/after). Makes changesets reviewable.

**Subset clone (M).** `--db subset`: full schema, full small tables, last N rows or date-window for big tables (`track_tables` gets a `where:`). Big WooCommerce/order tables stop dominating clone time.

**Anonymise on clone (M).** `db.anonymise: { wp_users.user_email: fake_email, … }` applied after snapshot restore. Lets agents work on prod-shaped data without PII. Plugs into the "db" step as a post-restore hook.

**Liquibase / Atlas / Flyway providers (S each).** Run the vendor container on the DDEV network, point at `db`. Atlas's declarative `schema.hcl` is a nice fit for the "desired schema in git" model.

**Applied-changeset ledger (S).** A `wt_changesets` table in each DB recording which `db/changes/*` dirs were applied; `wt db status` becomes accurate; `apply` becomes idempotent.

**Changeset conflicts (M).** When two worktrees both change `wp_options.sidebars_widgets`, flag it at `wt db export` time by comparing against other worktrees' pending exports. Cheap early warning before the merge.

**Seed scenarios (S).** `wt db seed checkout-with-coupons` runs a named SQL/WP-CLI script from `db/seeds/`. Agents get reproducible fixtures instead of hand-clicking content.

**Time-travel (S).** `wt db snapshot` already exists; add `--every 15m` auto-snapshots while the worktree is up and `wt db restore --at "10 minutes ago"`.

## 3. WordPress specifics

**Plugin/theme repo mode (M).** Repo *is* a plugin. `wt` keeps a site template (`.wt/site-template/`, a minimal WP with the DB dump) and symlinks the worktree into `wp-content/plugins/<slug>`. Every level-2 worktree is a full site with that branch of the plugin active.

**Multisite support (M).** Wildcard `additional_hostnames`, rewrite `wp_blogs`/`wp_site`, per-site search-replace. Flag `wordpress.multisite: subdomain|subdirectory`.

**Content freeze markers (S).** `wt wp freeze` records post IDs that exist at baseline; `wt db diff` distinguishes "edited existing" from "created new". Helps reviewers.

**Block-theme / FSE awareness (S).** Export `wp_global_styles`, template parts and patterns (which live in `wp_posts`) as separate readable JSON in `wp-changeset`.

**Media proxy (S).** Instead of symlinking uploads, nginx `try_files … @main` → fall back to main's `wp-content/uploads` URL. Zero filesystem coupling; works across hosts. Add as `media: proxy`.

**WP-CLI aliases (S).** `wt` writes `wp-cli.yml` aliases (`@feat-x`, `@main`) so `wp @feat-x option get home` works from anywhere.

## 4. Laravel specifics

**Queue & scheduler isolation toggles (S).** `--queue none|sync|worker`, `--scheduler on|off`. Some tasks need `schedule:run` to fire; most don't and it just burns CPU.

**Horizon / Telescope per worktree (S).** Add-on bundle that enables them with prefixed Redis so dashboards are per-branch.

**Factory/seeder fixture capture (M).** After an agent creates test data by hand, `wt laravel capture --model Order --since baseline` generates a seeder from the rows. Turns ad-hoc content into code.

**Octane/Reverb ports (S).** Map websockets through the router with `web_extra_exposed_ports` so Reverb works on the project hostname.

## 5. React / frontend

**Pairing (M).** `--pair ../api-repo` creates/links a backend worktree on the same branch, wires `VITE_API_URL`, and `destroy` tears down both. Manifest gains `pairedWith`.

**Storybook / preview per worktree (S).** Second exposed port → `https://feat-x.ddev.site:6006` or `storybook-feat-x.ddev.site` via `additional_hostnames`.

**Dependency cache (S).** pnpm store or `cp -c` (APFS clone) of `node_modules` from main; install goes from minutes to seconds.

**Visual diff hook (M).** On `wt db export` / PR time, screenshot a URL list (`.wt.yml: screenshots:`) in both main and the worktree with Playwright and attach a diff. Agents get "did I break the header" for free.

## 6. Agent ergonomics

**`wt context` (S).** Prints a compact JSON/markdown block: URL, level, DB strategy, what's tracked, pending changesets, next steps. Hook `UserPromptSubmit` can inject it so the agent always knows where it is.

**Budget guard (S).** `.wt.yml: budgets: { ram_gb: 12, disk_gb: 40 }`; `wt new` refuses when `docker stats` says the machine is near the limit, and tells the agent which idle worktree to `down`.

**Ownership & leases (S).** Manifest records `owner` (agent/session id) and a lease; `wt destroy` by another owner needs `--force`. `wt ls --mine`. Prevents two agents cleaning up each other.

**Event log (S).** `.wt/events.jsonl`: who created/destroyed what, when, from which task. `wt log` for humans; useful for post-mortems when an agent misbehaves.

**`wt explain <name>` (S).** Human-readable summary of everything generated: config file contents, symlinks, snapshot names, changesets. Makes the magic inspectable.

**Reviewer mode (M).** `wt review <pr-number>` fetches the branch, creates a worktree, applies its `db/changes`, prints URL. The human reviews a running site, not a diff.

**MCP server (M).** Thin wrapper exposing each command as a tool with JSON schema from commander definitions. Lets Cursor/Claude Desktop use `wt` without shell access.

**Notifications (S).** `.wt.yml: notify: slack_webhook` → message when a worktree is created/destroyed or gc removes something. Team visibility of what agents are doing.

## 7. Policy & safety

**Policy file for agents (S).** `.wt.yml: policy: { allow_destroy: own, allow_level: [0,2,3], require_task: true }`. `wt` enforces; agents can't silently create level-4 or destroy others' work.

**Protected paths (S).** `wt exec` and hooks refuse commands that target main's path; `wt doctor` warns when a worktree symlink points outside the repo.

**Secrets scrubbing (S).** `wt db export` scans output for API keys/emails (regex + deny tables) and refuses or redacts.

**Dry-run everywhere + plan files (S).** `wt new --plan-out plan.json` / `wt apply plan.json`. Lets a human approve an agent's plan before it runs; natural fit for Claude Code permission prompts.

## 8. Portability & install

**Single binary (M).** Node SEA or Bun compile → `wt` with no Node install. Homebrew tap + Scoop manifest.

**Windows/WSL2 (M).** Symlinks → junctions or `media: proxy`; DNS section already covers Acrylic. Test matrix in CI.

**Plain docker-compose backend (L).** `Backend` interface (`ddev` today) with a compose implementation for teams without DDEV. The planner calls `backend.start/stop/exec/snapshot`; adapters stay unchanged.

**Config profiles (S).** `.wt.yml` + `.wt.local.yml` (gitignored) + `~/.wt/config.yml`, merged like DDEV's overrides. Per-developer tweaks without committing.

## 9. Observability

**`wt top` (S).** Live table of worktrees with CPU/RAM/disk from `docker stats`, last HTTP hit, idle time. Basis for auto-`down`.

**Health probes (S).** Per-framework smoke URLs (`/wp-json`, `/up`, `/`) run by `wt doctor <name>` and by the warm pool before handing out an environment.

**Cost report (S).** `wt report --since 7d`: worktrees created, average lifetime, clone time, disk used, how many were gc'd unmerged — tells you whether agents are cleaning up.

---

## Suggested phase 2 (pick ~6)

If I had to choose the next sprint for maximum payoff with AI agents:

1. **Promote in place** — fixes the most common wrong-guess without recreation.
2. **Ownership/leases + policy file** — safety for multi-agent.
3. **`wt context` + UserPromptSubmit hook** — agents stop asking "where am I".
4. **DDL differ + applied ledger** — makes `db/changes` trustworthy.
5. **Media proxy mode** — removes the symlink-outside-worktree fragility on macOS/Windows.
6. **Warm pool** — creation latency is the thing agents feel most.

Everything else can follow demand.
