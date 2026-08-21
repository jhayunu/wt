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

Still unverified after this audit (needs Run 1): that a snapshot file copied between
projects actually restores; `ddev exec --dir` paths under Mutagen; media `proxy` through
the router; pool claim renaming.

### Run 1 — <date>, DDEV <version>

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
