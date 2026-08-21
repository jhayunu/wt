# Changelog

## 0.3.0

The first release with level 2 exercised against real DDEV (v1.25.1, WordPress, mutagen
enabled) rather than only the test shim. That run found eight bugs; three of them were
invisible to the shim by construction, because a fake `ddev delete` has no database volume
to drop and a fake `ddev exec` has no shell to mangle backticks.

### Added

- **`wt finish <name>`** — merge the worktree back into the branch it came from, delete the
  branch, destroy the environment. Prints the plan and does nothing without `--confirm`;
  `wt` never prompts, since an interactive question hangs an agent forever. Refuses while
  the worktree has uncommitted work, or has database changes that were never exported.
  Aborts cleanly on a merge conflict, leaving nothing half-merged.
- **`db.deny_rows`** in `.wt.yml` — per-row deny lists for key/value tables, keyed
  `<table>.<column>` with exact or prefix patterns. Defaults keep `cron`, transients,
  `mailserver_pass` and `recovery_keys` out of WordPress changesets.
- `wt doctor` checks a config file that exists but is untracked (it never reaches a
  worktree), a media path ignored only as `dir/` (which never matches the symlink `wt`
  puts there), and warm-pool entries whose DDEV project has vanished.
- `WorktreeRecord.from` records the base ref, so `wt finish` knows where to merge back to.

### Fixed

- **The warm pool handed over an empty database.** DDEV names the database volume after the
  project, so the `ddev delete` used to free the old name during a claim took the pooled
  data with it. The pool exists to have a database ready; it now snapshots before the
  rename and restores after.
- **`wt db apply` could never replay a changeset.** `ddev exec` runs through bash, and
  mysqldump always backtick-quotes identifiers, so the SQL was mangled before MySQL saw it;
  the WP-CLI path had the same problem with a double-quoted value. Both use stdin now.
- **`wt db export` wrote whole tables instead of deltas** — 130 of 130 `wp_options` rows for
  a one-option change — including `mailserver_pass`, which on a real site is an SMTP
  password headed for git.
- **A modified row counted as two changes.** Rows are keyed by primary key now, read from
  the schema dump already taken for the DDL diff.
- **`wp-changeset` reported every post as modified**, on worktrees where nothing had been
  touched, and exported all of them.
- The `wt_changesets` ledger appeared in the schema diff as a change the agent never made.
- A media path was ignored as `wp-content/uploads/`, which never matches the symlink `wt`
  substitutes from level 2 up — so every WordPress worktree was born dirty, and `git add -A`
  could commit the symlink over main's uploads directory.
- A failed pool claim left a phantom manifest entry pointing at a deleted environment, and
  debris that made the next claim fail with "path exists".
- `withRepoLock` was not re-entrant, so any command calling another locking command
  deadlocked against itself.

### Changed

- `wt db diff --json`: `data[table]` is now distinct rows affected. A modified row
  previously counted twice.
- `wt init` also ignores media paths without a trailing slash, and seeds
  `db/changes/.gitkeep`.

## 0.2.1

Levels 0 and 1 verified on real DDEV. Plugin packaging fixes: executable bits, first-run
build, version drift.

## 0.2.0

Levels 0–3 including `promote`, ownership leases and policy, the warm pool, media proxy,
the DDL differ and changeset ledger, `wt context` and the prompt hook, and `ddev` tool
passthroughs.
