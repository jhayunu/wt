# Changelog

## 0.5.0

Both of these came from watching `wt` used across many sessions rather than from a single
failing run: the trigger asked for an environment far more often than the work justified, and
a destroy that could not finish left a record behind that nothing would ever clean up.

### Changed

- **A worktree is no longer the answer to every edit.** The rule written into `CLAUDE.md`
  said any plan that edits files starts with `wt new`, and told the agent not to ask — so a
  typo, a comment or a version bump each got a worktree, and from level 2 up a DDEV
  environment to raise and tear down. The threshold is now what the isolation is actually
  for: work that *runs* something (a test suite, migrations, the app) or spans more than a
  file or two. Small self-contained edits stay in the main checkout, and a borderline call
  asks first. `Never edit files in the main checkout` became `never run migrations or a test
  suite against the main checkout`, which is the part that actually collides between
  sessions.
- **`wt init` and `wt skill install` now refresh an existing rule block in place.** They only
  ever appended, and skipped the file entirely once the marker was present, so a tightened
  rule could never reach an install that had already run. The block is delimited by a closing
  `<!-- /wt:worktrees -->` marker and rewritten between the two; blocks written before that
  marker existed are replaced up to the next heading, so a section you added underneath is
  left alone. Re-run either command to pick up this release's wording.

### Fixed

- **`wt destroy` could not finish if the worktree directory was already gone, and the leftover
  manifest entry counted against `max_concurrent` forever.** `git worktree remove` tolerates a
  missing directory only while the `.git/worktrees` admin entry survives; once anything has
  pruned it — `git gc` does, and so does removing the tree by hand — it fails with
  `is not a working tree`. Destroy aborted there, before the manifest entry was struck, so the
  record survived with nothing behind it and the next `wt new` refused to create anything. The
  removal now tolerates an already-absent path and prunes the stale entry; a removal that fails
  with the tree still on disk is still treated as a real error.

## 0.4.0

Found the same way as 0.3.0's bugs: by running `wt` against a real project rather than the
shim. A `wt destroy` took the whole DDEV project down with it, and no shim-based test could
have seen it — a fake `ddev start` has no Mutagen session to wedge.

### Fixed

- **Worktrees were inside main's Mutagen sync, and `wt destroy` could stop main from
  starting.** Worktrees live inside the approot so sibling symlinks resolve and level 0/1
  can borrow main's container — which also put every worktree's `vendor/` and
  `node_modules/` into main's file sync, and made a destroy delete a tree Mutagen was
  watching. One container-side write inside that tree (a `.DS_Store` will do) leaves a
  conflict Mutagen cannot resolve, and the project then fails to start with
  `unable to flush`. `wt init` now adds the worktrees directory to `upload_dirs`, which
  bind-mounts it into the web container *and* excludes it from Mutagen — an `ignore:` alone
  would have fixed the sync and broken level 0/1 routing. `wt doctor` fails when it is
  missing. Existing projects: re-run `wt init`, then `ddev mutagen reset && ddev restart`.

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
