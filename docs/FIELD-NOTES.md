# Field notes — real-DDEV runs

What actually happened when `wt` met a real DDEV, as opposed to the shim. One section
per run. Every fix that comes out of here should land a regression assertion in
`cli/test/smoke.sh` (or a unit test) in the same change.

## Environment baseline

Fill this in per run — DDEV changes snapshot/routing behaviour between minors.

| | |
|---|---|
| Date | |
| DDEV | `ddev version` |
| Docker | `docker info --format '{{.ServerVersion}}'` |
| Host | |
| Test site | throwaway WordPress — **never a client site** |
| DB type/version | from `.ddev/config.yaml` |

## Verified DDEV facts

Checked against the DDEV docs (Context7 `/ddev/ddev`) on 2026-08-21, DDEV v1.25.1 on
this machine:

- Snapshots are gzipped files in the project's **`.ddev/db_snapshots`** directory.
  `wt` copies them between projects there (`planner.ts stepDbClone`), which the docs
  support: snapshots may be renamed/moved **as long as the database type and version
  suffix is unchanged** (e.g. `wt-feat-x-mariadb_10.11.gz`).
- `wt` copies the file verbatim and main + worktree share the same `.ddev/config.yaml`,
  so the suffix matches by construction. It would only break if a worktree overrode the
  `database:` block — it does not.
- `ddev snapshot restore <name>` resolves the name out of that directory (`--latest`
  also exists), so a file dropped in before `restore` is findable. This is the
  assumption the whole `db: snapshot` strategy rests on — **confirm it empirically on
  the first run**, it is the single highest-risk step.
- `ddev snapshot` takes `-y`; **`ddev snapshot restore` does not** (`--latest` and
  `--help` only). Checked against `ddev snapshot restore --help`, v1.25.1.
- **`name:` can be overridden in `config.*.yaml`.** With `name: a` in `.ddev/config.yaml`
  and `name: b` in `.ddev/config.wt.local.yaml`, `ddev utility configyaml` reports the
  project as `b`. So a repo that pins its project name is not an obstacle: the worktree
  names itself. Verified in a scratch directory on v1.25.1 (no project registered).
- `ddev list --json-output` returns `{raw: [{name, status, approot, primary_url, …}]}`,
  and `primary_url` carries a non-default router port (e.g. `https://x.ddev.site:444`)
  when there is one — which is why `wt` derives worktree URLs from it rather than
  assembling `https://<name>.<tld>` blind.

## Runs

### Run 0 — 2026-08-21, static audit against DDEV v1.25.1 (no containers)

Not a real run: a read of every command `wt` issues, checked against `ddev <cmd> --help`
on v1.25.1 and against the Context7 docs, plus `npm test` / `test:smoke`. Everything
here would have shown up on the first real run; fixing it first makes that run about
DDEV behaviour rather than about typos.

**F1 — `ddev snapshot restore <name> -y` aborts (fatal).** Cobra rejects the unknown
shorthand, so *every* level-2 creation with `db: snapshot` would have failed at
`stepStart` and rolled back — the single most important step in the tool.
- Fix: `core/ddev.ts` — drop `-y` from `snapshotRestore`.
- Regression: `cli/test/smoke.sh` — fails if any logged `snapshot restore` call carries `-y`.

**F2 — `wt new --from` defaulted to the literal `main`.** Any repo whose trunk is
`master`, `master-dev`, `develop`, … could not create a worktree at all
(`invalid reference: main`).
- Fix: `core/git.ts currentRef()` + `commands/new.ts` — default to the main checkout's
  current branch (its HEAD sha when detached).
- Regression: `smoke.sh` scaffolds its repo on `master-dev` and asserts the new branch
  descends from it.

**F3 — repos that pin `name:` were told to remove it.** That renames the main project
and moves its URL — a real cost the tool imposed for no reason, and `wt new` would
otherwise have registered the worktree under *main's* project name and hijacked its
registry entry.
- Fix: `core/planner.ts stepWriteConfig` writes `name: <worktree>`;
  `core/ddevconfig.ts` reads `name:`/`project_tld:` from `.ddev/config.yaml` so
  `.wt.yml: main` and `tld` default correctly; `commands/init.ts` and `doctor` updated
  (doctor now checks the two names agree instead of demanding one be absent).
- Regression: `smoke.sh` pins `name: myshop`, omits `main:` from `.wt.yml`, and asserts
  the generated override contains `name: feat-x` and that `doctor` is still green.

**F4 — `wt db snapshot` never saved the manifest**, so the snapshot name was lost on
exit and `wt db restore <name>` — the undo the skill tells agents to rely on — found
nothing.
- Fix: `commands/db.ts` — `saveManifest` after recording the snapshot.

**F5 — level 4 got `media: copy`.** The ternary tested `lv >= 3` before `lv === 4`, so
"clean" inherited "full"'s media. Fix in `commands/new.ts makeRecord`; unit test in
`cli/test/records.test.ts`.

**F6 — `--level` accepted anything.** `--level nine` became `NaN` and produced a record
with no level, no URL and no containers. Now rejected with a hint; asserted in smoke.

**F7 — `wt gc` ran `docker builder prune -f`** on every machine-wide build cache
whenever it collected anything. Now opt-in behind `wt gc --prune`.

**F8 — worktree URLs ignored main's real URL.** A custom `project_tld` or a non-default
router port produced `.env`/`wp-config-wt.php` files pointing at a hostname that does
not serve. `core/ddevconfig.ts urlFor()` now swaps the first hostname label of main's
`primary_url`; unit-tested.

**F9 — `snapshot-diff` crashed on a table added to `track_tables` after creation**
(no baseline file). Treated as "was empty".

**F10 — generated `config.wt.local.yaml` carried a `"#"` YAML key** as a pseudo-comment.
Now a real comment line above the document.

**F11 — every hook died with "Permission denied" (fatal to the plugin).** `cli/bin/wt`
and all three `cli/scripts/*.sh` were tracked as `100644`. A plugin install is a git
checkout, so nothing restores the exec bit: SessionStart, UserPromptSubmit and Stop all
failed on a fresh install, and the plugin was inert.
- Fix: `git update-index --chmod=+x` on `bin/wt`, `scripts/*.sh`, `install.sh`;
  `hooks/hooks.json` now invokes each script as `sh "<path>"` so a lost mode cannot
  break the hooks again.
- Regression: `cli/test/smoke.sh` — asserts the index mode of each of those files is
  `100755`.

**F12 — the launcher looked like it hung on first use.** `dist/` and `node_modules/` are
gitignored, so a plugin install has neither and `bin/wt` builds on first call. It did
that silently: ~2.5 minutes of no output, which reads as a hang and gets killed. Worse,
three hooks can fire at once and each would have run `npm install` in the same directory.
- Fix: `cli/bin/wt` announces each stage on stderr, serialises the build behind a
  `.wt-build.lock` directory (losers wait for `dist/cli.js`, up to 10 min), skips
  `npm install` when `node_modules` already exists, and releases the lock *before*
  `exec` — an `EXIT` trap never fires across `exec`. `WT_NO_BUILD=1` exits 7 instead of
  building; all three hook scripts set it, so a hook can never block a session. When
  unbuilt, SessionStart prints the single command to run.
- Also: a global `wt` that resolves back to this same script is now ignored, so
  `exec wt "$@"` cannot loop forever.
- Regression: `smoke.sh` — asserts each hook script carries `WT_NO_BUILD` and that an
  unbuilt launcher exits 7.

**F13 — version drift across the three manifests.** `package.json` said 0.2.0 while
`cli/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` both said 0.1.0,
so `/plugin install` advertised the wrong version.
- Fix: all three at 0.2.0.
- Regression: `smoke.sh` — asserts the three agree.

Verified during this pass: a fresh `git checkout-index` of the repo — what a plugin
install gets — builds via `bin/wt` and answers `--version` in ~3 s, with four concurrent
first-run callers producing exactly one build and no leftover lock.

Still unverified after this audit (needs Run 1): that a snapshot file copied between
projects actually restores; `ddev exec --dir` paths under Mutagen; media `proxy` through
the router; pool claim renaming.

### Run 1 — 2026-08-21, DDEV v1.25.1, lara-pelikan (Laravel 12 + React, "composite"), **level 1 only**

First contact with a real DDEV. Level 1 only: no per-worktree project, no DB clone. The
repo is Mutagen-synced and large (198,065 files / 4.2 GB), which turned out to matter.

| # | Step | Result | Notes |
|---|---|---|---|
| 1 | `/plugin install wt@gitworktrees` | ✗→✓ | shipped non-executable — F11 |
| 2 | `wt init` | ✓ | wrote `main: lara-pelikan` from `.ddev/config.yaml`, `.gitignore` entries, CLAUDE.md rule |
| 3 | `wt doctor` | ✓ | all five checks green against a running main |
| 4 | `wt new wt/smoke --level 1` | ✓ | branch cut from the checked-out branch; ~2 s |
| 5 | `wt exec` / `wt php` routing | ✓ | `pwd` → `/var/www/html/.wt/worktrees/wt-smoke`, `php -v` → 8.4.18 |
| 6 | `wt composer … install --no-scripts` | ✓ | 214 packages, ~3 min including sync-back |
| 7 | `wt artisan … --version` | ✗→✓ | F12, F13 |
| 8 | main checkout unaffected | ✓ | `ddev artisan --version` → Laravel 12.65.0; main's autoloader untouched |
| 9 | `wt destroy` ×2 | ✓ | trees, branches and manifest entries all gone |

#### Findings

**F11 — the plugin installs non-executable (fatal, silent).** `bin/wt`, all three
`scripts/*.sh` and `install.sh` were mode `100644` in git, so every clone and every
plugin install lands them unrunnable. `commands/wt.md` and all three hooks invoke those
paths directly, and hooks swallow their own failures — so the symptom is not an error,
it is the `wt:` context line simply never appearing.
- Fix: `git update-index --chmod=+x` on all five.
- Regression: `cli/test/packaging.test.ts` asserts the executable bit on each.

**F12 — a fresh worktree is not a runnable checkout: missing gitignored dirs.**
`php artisan` died with "The …/bootstrap/cache directory must be present and writable".
`git worktree add` gives you what git tracks, and `bootstrap/cache` is gitignored in
most Laravel repos (`storage/framework/*` usually is not — it carries `.gitignore`
files — but do not rely on that).
- Fix: `Adapter.requiredDirs?()` + `planner.ts stepPrepareTree`; Laravel declares
  `bootstrap/cache`, `storage/framework/{cache/data,sessions,views}`, `storage/logs`.

**F13 — level 0/1 worktrees got no `.env` at all.** `envFiles()` only runs inside
`stepWriteConfig`, which is level ≥ 2. Laravel therefore booted with `APP_ENV`
defaulting to `production` and hit this project's own production guard
(`MICROSOFT_AZURE_TENANT_ID must be set…`) — a failure with no visible connection to
worktrees.
- Fix: `Adapter.sharedFiles?()` — at level < 2 copy main's `.env` verbatim, which is
  correct there because level 1 *is* main's environment, just a different tree.

**F14 — `wt new` returned before the container could see the tree.** On Mutagen-synced
projects the host checkout exists immediately but the web container does not see it for
several seconds; the very next `wt composer …` failed with "no such file or directory".
- Fix: `planner.ts stepAwaitContainerSync` polls before `wt new` returns (120 s cap,
  `optional`). It logged "synced" on the re-run, so it does wait rather than pass through.
- Amended the same day: polling for `.git` alone was not enough. It is one small file and
  lands ahead of the checkout, so the very next call still failed with "Could not open
  input file: artisan". Adapters now declare a `treeMarker()` (Laravel `artisan`, React
  `package.json`, WordPress `wp-config.php`, Drupal `web/core/lib/Drupal.php`) and the
  step waits for all of them. Re-verified in ppm: `wt exec … ls artisan package.json`
  immediately after `wt new` lists both.

**F15 — a worktree still needs its dependencies installed, and the failure did not say so.**
`vendor/` and `node_modules/` are not in git. Without them the error is
"Could not open input file: artisan" or a failed autoload require — which reads as a
broken worktree, not a missing install.

Resolved by naming it rather than by installing automatically: on a large repo an
unconditional `composer install` costs minutes and pushes thousands of files through the
sync, and plenty of tasks never boot the app.

- Adapters declare `dependencies()` (marker + the command that creates it).
- `wt new` ends with a `hint:` line naming exactly what is missing, in the same
  `wt <tool> <name> -- …` form the agent already uses.
- Any tool passthrough that exits non-zero with a marker missing appends the same hint.
- `wt new --install` runs them at creation for anyone who wants it — after the sync wait
  at level 1, after `ddev start` at level 2+ (`ddev composer` needs the containers up).

Open question for Run 2: at level ≥ 2 the post-start hooks (`php artisan migrate --force`,
`storage:link`) run before any install, so they will fail on a fresh worktree unless
`--install` was passed. Either make `--install` the default at level ≥ 2, or move the
hooks behind a dependency check.

**Not yet observed (needs a level ≥ 2 run):** snapshot copy + restore across projects,
media symlink/proxy, pool claim, `wt db diff/export`. Everything in "Verified DDEV facts"
above about snapshots is still documentation, not experience.

#### Ownership caveat

Records were owned by `jhayar@HQT-F20PJ9QKYH`, not `claude:<session>`: `CLAUDE_SESSION_ID`
is not exported into the shell Claude Code runs commands in, so the per-agent lease
degrades to per-user. Ownership still separates humans/machines; it does not separate two
agents on one machine, which is the case it was written for.

### Run 2 — <date>, DDEV <version> (WordPress, levels 2+)

Steps from `PLAN.md` §2. Record each as ✓ / ✗ + what happened.

| # | Step | Result | Notes |
|---|---|---|---|
| 1 | `wt init` + ACTION lines | | |
| 2 | `ddev start` main, `wt doctor` all ✓ | | |
| 3 | `wt new feat/test` → URL loads, admin logged in, media shows | | |
| 4 | `wt wp feat-test option get home` = worktree URL | | |
| 5 | change option + post → `wt db diff` → `wt db export` | | |
| 6 | `wt db reset`, `wt promote --media proxy` / back to `symlink` | | |
| 7 | `wt pool fill 1` → `wt new --pool` claims, no `pool-` in `home` | | |
| 8 | `wt destroy` both → `ddev list`, `git worktree list`, manifest clean | | |

#### Findings

<!-- One per finding:

**F1 — <symptom>**
- Observed:
- Cause:
- Fix: `<file>` — <what changed>
- Regression: `cli/test/smoke.sh` — <assertion added>
-->

#### Secrets / URL leak check (step 5)

`wt db export` writes `db/changes/…/{wp-changeset,snapshot-diff}/` and those files get
committed. Read them before trusting the format:

- [ ] no API keys, licence keys or SMTP passwords from `wp_options`
- [ ] no user emails / password hashes
- [ ] no absolute host paths
- [ ] worktree hostname not baked in where the main hostname belongs
