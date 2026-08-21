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

## Runs

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
