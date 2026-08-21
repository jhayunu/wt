import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE } from "../core/config.js";
import { detectAdapters, frameworkOf } from "../adapters/index.js";
import { readDdevConfig } from "../core/ddevconfig.js";
import { ensureClaudeMd, REPO_BLOCK } from "../core/claudemd.js";
import { emit, type Env } from "../core/context.js";

const TEMPLATE = (main: string, fw: string, tld?: string) => `# wt — per-worktree environments. See ARCHITECTURE.md
main: ${main}                # DDEV project name of this (canonical) checkout
${tld ? `tld: ${tld}\n` : ""}framework: auto             # detected: ${fw}
min_level: ${fw === "wordpress" ? 2 : 0}
max_level: 4
max_concurrent: 4
worktrees_dir: .wt/worktrees
defaults:
  db: snapshot              # snapshot | dump | fresh | none
  media: symlink            # symlink | copy | none
hints:                      # regex on --task → minimum level
  "migration|schema|seeder": 2
  "import|media|thumbnail|upload|resize": 3
db:
  change_provider: auto     # auto | snapshot-diff | laravel-migrations | wp-changeset | [list]
  changes_dir: db/changes
  track_tables: ${fw === "wordpress" ? "[wp_options, wp_posts, wp_postmeta, wp_terms, wp_term_taxonomy, wp_term_relationships]" : "[]"}
  deny_tables: [wp_users, wp_usermeta, sessions, personal_access_tokens]
laravel:
  auto_migrate: true
  queue: per-project
wordpress:
  search_replace_extra: []
  exclude_tables: []
react:
  port_range: [5180, 5280]
policy:
  allow_destroy: own        # own | any — others need --force during the lease
  allow_levels: [0, 1, 2, 3, 4]
  require_task: false
  lease_hours: 24
seed:                       # for db: seedfile — creation no longer needs main to be running
  file: db/seed.sql.gz
  refresh: export-main      # export-main | ddev-pull | none
  pull_env: prod
pool:
  size: 0                   # >0: "wt pool fill" pre-builds environments that "wt new" claims
  level: 2
`;

const IGNORES = [".wt/", "wp-config-wt.php", ".env.local", ".ddev/config.wt.local.yaml", ".ddev/nginx/wt-media.conf", ".ddev/db_snapshots/wt-*", "db/seed.sql.gz"];

/**
 * Written into the repo's CLAUDE.md so the rule travels with the *repository* —
 * to every machine and every teammate who clones it. A rule that lives only in
 * ~/.claude/CLAUDE.md is machine-local and is the first thing lost on a new laptop.
 */
const CLAUDE_MARKER = "<!-- wt:worktrees -->";
const CLAUDE_BLOCK = [
  CLAUDE_MARKER,
  "## Worktrees (wt)",
  "",
  "This repo uses `wt`: every branch gets its own worktree, and from isolation level 2 up its own DDEV environment (URL, database, media).",
  "",
  "**Decide at plan time.** If the plan involves editing files, running migrations or running a test suite, its first step is `wt new <branch> --task \"<what the plan does>\"`, and everything after it happens inside `worktree.path`. Read-only work — answering questions, reading code, reviewing a diff — stays in the main checkout. With no plan (a one-line ask that turns into an edit), take the worktree before the first edit rather than after. State the choice in one line; do not ask permission.",
  "",
  "Never edit files or run migrations in the main checkout. Never run `ddev …` from inside a level 0/1 worktree — route tooling through `wt npm|composer|artisan|wp|exec <name> …`, which lands in the right container either way. Before a PR: `wt db diff <name>`, then `wt db export <name>` if it reports anything. When the work is merged or abandoned: `wt destroy <name>`.",
  "",
  "Worktrees owned by another agent are not yours to destroy or promote; `wt ls` shows who owns what.",
  "",
].join("\n");

export async function cmdInit(env: Env) {
  const notes: string[] = [];
  const cfgPath = path.join(env.repoRoot, CONFIG_FILE);
  const fw = frameworkOf(await detectAdapters(env.repoRoot, "auto"));
  if (existsSync(cfgPath)) notes.push(`${CONFIG_FILE} exists — left untouched`);
  else {
    const ddevCfg = await readDdevConfig(env.repoRoot);
    const main = ddevCfg.name ?? path.basename(env.repoRoot);
    await writeFile(cfgPath, TEMPLATE(main, fw, ddevCfg.tld));
    notes.push(`wrote ${CONFIG_FILE} (framework: ${fw}, main: ${main})`);
  }

  const gi = path.join(env.repoRoot, ".gitignore");
  const cur = existsSync(gi) ? await readFile(gi, "utf8") : "";
  const missing = IGNORES.filter((l) => !cur.split("\n").includes(l));
  if (missing.length) { await appendFile(gi, `\n# wt\n${missing.join("\n")}\n`); notes.push(`.gitignore += ${missing.join(", ")}`); }

  const ddevCfg = path.join(env.repoRoot, ".ddev", "config.yaml");
  if (existsSync(ddevCfg)) {
    const y = await readFile(ddevCfg, "utf8");
    const pinned = /^name:\s*(\S+)/m.exec(y)?.[1];
    if (pinned) notes.push(`note: .ddev/config.yaml pins name: ${pinned}. That is fine — wt writes its own \`name:\` into each worktree's .ddev/config.wt.local.yaml, which DDEV merges on top. Just keep \`main: ${pinned}\` in ${CONFIG_FILE} in step with it.`);
  } else notes.push("no .ddev/config.yaml found — run `ddev config` in this checkout first");

  // The rule that decides *when* to take a worktree belongs in the repo, not in a
  // machine-local config: that is what survives a new machine and reaches teammates.
  const claudeMd = path.join(env.repoRoot, "CLAUDE.md");
  notes.push((await ensureClaudeMd(claudeMd, REPO_BLOCK)) === "present"
    ? "CLAUDE.md already carries the wt worktree rule — left untouched"
    : 'CLAUDE.md += "Worktrees (wt)" section — commit it: that is how the rule reaches other machines and other people');

  if (fw === "wordpress") notes.push("WordPress: add to wp-config.php before the settings block:  if (file_exists(__DIR__ . '/wp-config-wt.php')) require __DIR__ . '/wp-config-wt.php';");
  emit(env, { notes }, notes);
}
