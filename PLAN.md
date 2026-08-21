# wt — working plan (hand-off to Claude Code)

Last updated: 2026-08-21. Read `CLAUDE.md` first for repo conventions, then this file for what to do.

## 0. Where things stand

- `ARCHITECTURE.md` — design (authoritative). §4 levels, §6 adapters, §7.5 routing, §7.6 DB change tracking, §14 prior art.
- `BRAINSTORM.md` — idea backlog, not commitments.
- `cli/` — TypeScript CLI `wt` **v0.2**, also a Claude Code plugin (`cli/.claude-plugin/plugin.json`, marketplace at `./.claude-plugin/marketplace.json`).
- Everything has been tested only against a **fake `ddev` shim** (see §2) plus unit tests. **No real DDEV run yet.** That is the first job.

What exists (commands): `init clone new ls url exec up down promote destroy gc doctor context`, tool passthroughs `npm npx yarn pnpm node composer artisan wp php mysql drush`, `db snapshot|restore|reset|diff|export|apply|status|seed`, `pool fill|ls|drain`, `skill install`.

## 1. Build & test loop

```bash
cd cli
npm install
npm run typecheck        # tsc --noEmit
npm test                 # node --test (unit: slug, inferLevel, ddl-diff, policy)
npm run test:smoke       # shim-based end-to-end (see below)
npm run build && npm link   # global `wt`
```

Shim-based smoke test (no Docker needed) — now lives in `cli/test/smoke.sh`:

```bash
npm run test:smoke      # scaffolds a temp WP repo, puts a fake `ddev` on PATH,
                        # drives new → ls → url → context → pool claim → destroy
KEEP=1 npm run test:smoke   # keep the scratch dir and print its path
npm run test:all        # unit + smoke
```

Re-run it (and add assertions) whenever you touch `core/planner.ts` or a command.

## 2. Task A — first real DDEV run (highest priority)

Use a throwaway WordPress DDEV project. Do not use a client site.

1. `cd <site> && wt init` → follow ACTION lines: remove `name:` from `.ddev/config.yaml`; add to `wp-config.php` above the settings block:
   `if (file_exists(__DIR__ . '/wp-config-wt.php')) require __DIR__ . '/wp-config-wt.php';`
2. `ddev start` (main), `wt doctor` must be all ✓.
3. `wt new feat/test --task "smoke test"` → expect `https://feat-test.ddev.site` to load, logged-in admin works, media shows (symlinked).
4. `wt wp feat-test option get home` → must be the worktree URL.
5. In wp-admin of the worktree change an option and create a post → `wt db diff feat-test` shows both → `wt db export feat-test` writes `db/changes/…/{wp-changeset,snapshot-diff}/` → inspect for readability and for leaked secrets/URLs.
6. `wt db reset feat-test` → changes gone. `wt promote feat-test --media proxy` → site still serves media (now via router). `wt promote feat-test --media symlink` back.
7. `wt pool fill 1` then `wt new feat/pooled --task t` → must claim; URL must be the new hostname, `wp option get home` must NOT contain `pool-`.
8. `wt destroy` both; `ddev list` must not show them; `git worktree list` clean; `.wt/manifest.json` empty.

Known risk points and where to fix them:

| Symptom | Likely cause | Fix location |
|---|---|---|
| snapshot restore fails / not found | copied file naming differs from what `ddev snapshot restore <name>` expects, or snapshots are stored outside `.ddev/db_snapshots` in newer DDEV | `core/planner.ts stepDbClone` / `stepStart`; fallback: switch default to `dump` |
| URLs still point at main | hooks ran before restore; second `ddev start` not re-running hooks | `stepStart` — replace second start with explicit `ddev exec wp search-replace …` using `adapters/wordpress.ts` logic |
| `ddev exec --dir` path wrong | container path isn't `/var/www/html/<rel>` (e.g. mutagen or custom docroot) | `commands/tools.ts`, `commands/misc.ts cmdExec`: derive from `ddev describe -j` `approot` |
| pool claim: project name not updated | DDEV caches project by approot; `ddev delete` before move insufficient | `planPoolClaim`: try `ddev stop --unlist <old>` then `ddev start` in new dir; keep `.ddev/traefik` removal |
| proxy media 502 | router hostname/TLS | `mediaProxyConf` in `core/planner.ts` — test `curl -k --resolve` from inside web container to `ddev-router` |
| `wp search-replace` breaks serialized data | missing `--precise`/`--recurse-objects` already set; check `--skip-columns=guid` appropriateness | `adapters/wordpress.ts ddevOverrides` |

Record findings in `docs/FIELD-NOTES.md` — the template is now there, with a step-by-step
table matching §2.1–8, a findings format and a secrets/leak checklist for step 5. Every fix
gets a shim-level regression in `cli/test/smoke.sh` where possible.

Already de-risked (2026-08-21, verified against Context7 `/ddev/ddev`; this machine has DDEV
v1.25.1 + Docker 29.3.1): snapshots live in `.ddev/db_snapshots` as gzipped files and may be
moved between projects **provided the `-<dbtype>_<version>.gz` suffix is unchanged** — which
`stepDbClone` satisfies, since it copies the file verbatim and both projects read the same
`.ddev/config.yaml`. So risk-table row 1 is narrower than feared: what still needs empirical
proof is only that `ddev snapshot restore <name>` picks up a file dropped into a *different*
project's snapshot dir.

## 3. Task B — repo hygiene (can run in parallel with A)

3.1–3.5 are **done** (2026-08-21). 3.6/3.7 need Jhay: they publish.

3.1 ~~Move the shim smoke test into `cli/test/smoke.sh`, wire into `npm test` as `test:smoke`.~~ **Done** — plus `test:all`; asserts on manifest, generated ddev override, uploads symlink, git worktree state and the ddev call log, and covers pool claim.
3.2 ~~`.github/workflows/ci.yml`: node 20 + 22, `npm ci`, `typecheck`, `test`, `test:smoke`.~~ **Done** — untested until the repo is pushed (3.6).
3.3 ~~Root `README.md` (short; links to ARCHITECTURE, cli/README, PLAN).~~ **Done.**
3.4 ~~Root `.gitignore` (`node_modules/`, `dist/`, `*.tgz`).~~ **Done.**
3.5 ~~Delete stray `cli/skill/` if still present (superseded by `cli/skills/wt/`).~~ **Done** — it was stale (pre-`promote`, pre-passthrough wording); nothing referenced it (`commands/skill.ts` reads `skills/wt`).
3.6 ~~`git init`, first commit~~ **Done**, pushed to **`jhayunu/GitWorktrees` (private)** — not `jhayar/…`: the `gh` credentials on this machine are `jhayunu` / `jhayiwg`. Repo paths in `README.md`, `cli/README.md`, `cli/install.sh` and `package.json:repository` updated to match; the npm name `@jhayar/wt` is untouched pending §6.1.
  **Still to verify:** `/plugin marketplace add jhayunu/GitWorktrees` + `/plugin install wt@gitworktrees` in Claude Code. While the repo is private this may only resolve for an authenticated account — if it fails, use `/plugin marketplace add /Users/jhayar/Development/docker/GitWorktrees` (local path) or make the repo public.
3.7 Tag `v0.2.0`; optionally `npm publish` (`@jhayar/wt`, `publishConfig.access=public`). `package.json` + `cli.ts --version` are now `0.2.0` (were `0.1.0`); resolve §6.1 (npm name) before publishing.

## 4. Task C — phase 3 backlog (after A passes)

Ordered by value for agent workflows. Each item: spec pointer → files → acceptance.

C1 **`wt db rollback <name>`** — restore `wt-pre-task` (or latest `pre-migrate`) snapshot and re-run URL fixups. Files: `commands/db.ts`, adapters add `preMigrateSnapshot()` before `artisan migrate`. Accept: migrate → rollback → `migrate:status` shows pending again.

C2 **Level 4 fresh installs** — `db: fresh`: WordPress `wp core install` with worktree URL + admin from `.wt.yml: wordpress.install`; Laravel `migrate:fresh --seed`; Drupal `drush si`. Files: adapters `freshInstall(ctx)`, `planner.stepStart`. Accept: `wt new x --level 4` yields working site with empty uploads.

C3 **Exec path derivation** — replace hard-coded `/var/www/html` with `ddev describe -j` lookup (also fixes custom docroots). Files: `core/ddev.ts` (`describe()`), `commands/tools.ts`, `misc.ts`.

C4 **Bare-clone layout option** (`wt init --layout bare`, `wt clone --layout bare`) — `.bare/` + `.git` pointer + `spaces/`; `.wt.yml: anchor: main` names the worktree whose container level-1 borrows. Files: `commands/init.ts`, `clone.ts`, `core/git.ts repoRoot()` (handle `.git` file), `context.ts worktreePath()`. Accept: all smoke steps pass in both layouts.

C5 **`--db subset`** — schema + full small tables + `where:` windows for big ones (`.wt.yml: db.subset: { wp_posts: "post_date > NOW() - INTERVAL 90 DAY" }`). Files: new `core/dbclone.ts`, `planner.stepDbClone`.

C6 **Anonymise on clone** — `.wt.yml: db.anonymise: { "wp_users.user_email": email, "wp_users.user_pass": hash }` applied after restore via `mysql` UPDATEs. Files: `core/anonymise.ts`, hook into `stepStart`.

C7 **React `--pair <repo>`** — create/link a sibling worktree in another repo on the same branch, wire `VITE_API_URL` both ways, destroy together. Files: `commands/new.ts`, `types.ts` (`pairedWith`), `adapters/react.ts envFiles`.

C8 **WordPress multisite** — `wordpress.multisite: subdomain|subdirectory`; wildcard `additional_hostnames: ["*.<name>"]`; rewrite `wp_blogs`/`wp_site`; `--network` on search-replace. Files: `adapters/wordpress.ts`.

C9 **Liquibase provider** — `providers/liquibase.ts`: run `liquibase/liquibase` container on the DDEV network against `db`; `diff-changelog` for export, `update` for apply; register in `providers/index.ts`. Accept: `change_provider: liquibase` produces a changelog an existing Liquibase user would accept.

C10 **MCP wrapper** — `cli/src/mcp.ts` exposing each command as a tool (schemas generated from commander); `bin: wt-mcp`. Accept: Claude Desktop can create/destroy a worktree without shell access.

C11 **Budget guard + auto-down** — `.wt.yml: budgets: { ram_gb, disk_gb }`; `wt new` refuses over budget; `wt gc --idle 3h` stops projects with no HTTP hits (router access log). Files: `commands/new.ts`, `misc.ts cmdGc`, `core/docker.ts`.

C12 **Event log** — `.wt/events.jsonl` appended by every mutating command; `wt log [--json]`. Cheap, helps post-mortems.

## 5. Definition of done (per task)

- `npm run typecheck` and `npm test` green; smoke script green.
- New behaviour has a shim-level test or a unit test.
- `cli/README.md` and, if design changed, `ARCHITECTURE.md` updated in the same change.
- `wt --json …` output shape unchanged unless documented (agents depend on it).
- No interactive prompts, ever. Errors carry an exit code and a `hint`.

## 6. Open decisions for Jhay

1. npm scope/name: `@jhayar/wt` is a placeholder — confirm or rename (also in `install.sh`, `README.md`, marketplace).
2. Default layout: keep nested (`.wt/worktrees/`) or switch default to bare once C4 lands?
3. Default DB strategy for WordPress: `snapshot` (needs main running) or `seedfile` (needs `wt db seed` discipline)?
4. Should `policy.require_task` default to `true` for agent-heavy repos?
