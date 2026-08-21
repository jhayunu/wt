import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE } from "../core/config.js";
import { detectAdapters, frameworkOf } from "../adapters/index.js";
import { emit, type Env } from "../core/context.js";

const TEMPLATE = (main: string, fw: string) => `# wt — per-worktree environments. See ARCHITECTURE.md
main: ${main}                # DDEV project name of this (canonical) checkout
framework: auto             # detected: ${fw}
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

export async function cmdInit(env: Env) {
  const notes: string[] = [];
  const cfgPath = path.join(env.repoRoot, CONFIG_FILE);
  const fw = frameworkOf(await detectAdapters(env.repoRoot, "auto"));
  if (existsSync(cfgPath)) notes.push(`${CONFIG_FILE} exists — left untouched`);
  else { await writeFile(cfgPath, TEMPLATE(path.basename(env.repoRoot), fw)); notes.push(`wrote ${CONFIG_FILE} (framework: ${fw})`); }

  const gi = path.join(env.repoRoot, ".gitignore");
  const cur = existsSync(gi) ? await readFile(gi, "utf8") : "";
  const missing = IGNORES.filter((l) => !cur.split("\n").includes(l));
  if (missing.length) { await appendFile(gi, `\n# wt\n${missing.join("\n")}\n`); notes.push(`.gitignore += ${missing.join(", ")}`); }

  const ddevCfg = path.join(env.repoRoot, ".ddev", "config.yaml");
  if (existsSync(ddevCfg)) {
    const y = await readFile(ddevCfg, "utf8");
    if (/^name:/m.test(y)) notes.push("ACTION: remove the `name:` line from .ddev/config.yaml so each worktree gets its own DDEV project name (DDEV derives it from the directory). Then `ddev start` main once.");
  } else notes.push("no .ddev/config.yaml found — run `ddev config` in this checkout first");

  if (fw === "wordpress") notes.push("WordPress: add to wp-config.php before the settings block:  if (file_exists(__DIR__ . '/wp-config-wt.php')) require __DIR__ . '/wp-config-wt.php';");
  emit(env, { notes }, notes);
}
