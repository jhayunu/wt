/**
 * Keeping worktrees out of main's Mutagen sync.
 *
 * Worktrees live *inside* main's approot on purpose (ARCHITECTURE §7.4): sibling symlinks
 * resolve, and level 0/1 tool routing borrows main's web container with
 * `ddev exec --dir /var/www/html/<worktrees_dir>/<name>`. The cost is that every worktree's
 * `vendor/` and `node_modules/` land inside main's Mutagen sync scope, which produces two
 * failures on a real project:
 *
 *   - sync volume grows by the full size of every worktree, for files no one reads through
 *     main's URL;
 *   - `wt destroy` deletes a directory tree on the host while the container may still be
 *     writing inside it, and Mutagen cannot reconcile "parent deleted on alpha" against
 *     "child created on beta". The session wedges with `unable to flush`, and the project
 *     will not start.
 *
 * A plain `ignore:` in `.ddev/mutagen/mutagen.yml` would fix the sync and break level 0/1,
 * because an ignored path simply does not exist in the container. `upload_dirs` does both
 * halves: DDEV bind-mounts those directories *and* excludes them from Mutagen — the same
 * trick DDEV's own performance docs recommend for `node_modules`.
 *
 * Verified on DDEV v1.25.1: `upload_dirs: [../.wt/worktrees]` with `docroot: public` yields
 * an `ignore` entry of `/.wt/worktrees` and a bind-mount of
 * `<approot>/.wt/worktrees:/var/www/html/.wt/worktrees`. Paths are resolved relative to the
 * **docroot**, not the approot — `.wt/worktrees` under `docroot: public` silently means
 * `public/.wt/worktrees`, which excludes nothing.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import type { DdevProjectConfig } from "./ddevconfig.js";

/** The `upload_dirs` entry that excludes `worktreesDir`, as DDEV resolves such paths. */
export function uploadDirEntry(docroot: string | undefined, worktreesDir: string): string {
  const from = (docroot ?? "").replace(/^\.?\//, "").replace(/\/+$/, "");
  const to = worktreesDir.replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!from || from === ".") return to;
  return path.posix.relative(from, to);
}

/**
 * Is Mutagen in play for this project?
 *
 * `performance_mode` decides it when set. When it is not, the effective value comes from
 * DDEV's global config and platform default, which wt cannot read from the project — so we
 * use the one local fact that is unambiguous: DDEV writes `.ddev/mutagen/mutagen.yml` when
 * it starts a project with Mutagen enabled. That means a never-started project reads as
 * "no", and `wt doctor` is what catches it after the first start. Guessing the platform
 * default instead would make `wt init` add an `upload_dirs` entry — which also retargets
 * `ddev import-files` — to projects that never needed one.
 */
export function mutagenInPlay(repoRoot: string, cfg: DdevProjectConfig): boolean {
  if (cfg.performanceMode) return cfg.performanceMode === "mutagen";
  return existsSync(path.join(repoRoot, ".ddev", "mutagen", "mutagen.yml"));
}

export interface ExclusionPlan {
  /** the docroot-relative entry that must appear in upload_dirs */
  entry: string;
  /** already there — nothing to do */
  present: boolean;
  /**
   * The full list to write. Existing entries keep their order and ours goes last:
   * `ddev import-files` and `DDEV_FILES_DIR` use the *first* entry, so appending leaves
   * a project that already had a real upload directory behaving exactly as before.
   */
  uploadDirs: string[];
}

export function planExclusion(docroot: string | undefined, worktreesDir: string, existing?: string[]): ExclusionPlan {
  const entry = uploadDirEntry(docroot, worktreesDir);
  const cur = existing ?? [];
  const present = cur.some((d) => normalise(d) === normalise(entry));
  return { entry, present, uploadDirs: present ? cur : [...cur, entry] };
}

const normalise = (d: string) => path.posix.normalize(d.trim()).replace(/\/+$/, "");

/** `ddev mutagen reset` is required after upload_dirs change — say so in one place. */
export const RESET_HINT = "run `ddev mutagen reset && ddev restart` for it to take effect";
