import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_FILE } from "../core/config.js";
import { detectAdapters, frameworkOf } from "../adapters/index.js";
import { effectiveUploadDirs, readDdevConfig, type DdevProjectConfig } from "../core/ddevconfig.js";
import { RESET_HINT, mutagenInPlay, planExclusion } from "../core/mutagen.js";
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

const LOCAL_CFG = path.join(".ddev", "config.wt.local.yaml");

const EXCLUSION_HEADER = [
  "# wt-generated. Keeps the worktrees directory out of main's Mutagen sync.",
  "#",
  "# Worktrees live inside the approot on purpose, which would otherwise put every worktree's",
  "# vendor/ and node_modules/ inside main's sync — and make `wt destroy` race the container",
  "# for a directory Mutagen is watching, wedging the session with \"unable to flush\".",
  "# upload_dirs is the one setting that both bind-mounts a directory into the web container",
  "# (so level 0/1 tool routing still reaches it) and excludes it from Mutagen.",
  "#",
  "# Paths are relative to the docroot. upload_dirs replaces rather than appends, so a real",
  `# upload directory must be listed here too. After changing this file, ${RESET_HINT}.`,
].join("\n");

/**
 * Adds the worktrees directory to main's `upload_dirs`, via the one DDEV file wt is allowed
 * to write. See core/mutagen.ts for why upload_dirs and not a Mutagen `ignore`.
 */
async function excludeWorktreesFromMutagen(env: Env, ddev: DdevProjectConfig): Promise<string[]> {
  if (!mutagenInPlay(env.repoRoot, ddev)) return [];
  const plan = planExclusion(ddev.docroot, env.cfg.worktrees_dir, await effectiveUploadDirs(env.repoRoot));
  if (plan.present) return [`${LOCAL_CFG}: ${env.cfg.worktrees_dir} is already excluded from Mutagen — left untouched`];

  const p = path.join(env.repoRoot, LOCAL_CFG);
  const existing = existsSync(p) ? ((YAML.parse(await readFile(p, "utf8")) ?? {}) as Record<string, unknown>) : {};
  await writeFile(p, `${EXCLUSION_HEADER}\n${YAML.stringify({ ...existing, upload_dirs: plan.uploadDirs })}`);
  return [`${LOCAL_CFG}: upload_dirs += ${plan.entry} — keeps ${env.cfg.worktrees_dir} out of Mutagen while still bind-mounting it into the web container; ${RESET_HINT}`];
}

export async function cmdInit(env: Env) {
  const notes: string[] = [];
  const cfgPath = path.join(env.repoRoot, CONFIG_FILE);
  const fw = frameworkOf(await detectAdapters(env.repoRoot, "auto"));
  const ddev = await readDdevConfig(env.repoRoot);
  if (existsSync(cfgPath)) notes.push(`${CONFIG_FILE} exists — left untouched`);
  else {
    const main = ddev.name ?? path.basename(env.repoRoot);
    await writeFile(cfgPath, TEMPLATE(main, fw, ddev.tld));
    notes.push(`wrote ${CONFIG_FILE} (framework: ${fw}, main: ${main})`);
  }

  const gi = path.join(env.repoRoot, ".gitignore");
  const cur = existsSync(gi) ? await readFile(gi, "utf8") : "";
  // Media dirs need the slash-less form too: from level 2 up wt replaces them with a
  // symlink, and a `dir/` pattern only ever matches a directory — so the symlink shows up
  // as untracked and every worktree is born dirty.
  const mediaIgnores = env.adapters.flatMap((a) => a.mediaPaths?.() ?? []).map((m) => m.replace(/\/$/, ""));
  const missing = [...IGNORES, ...mediaIgnores].filter((l) => !cur.split("\n").includes(l));
  if (missing.length) { await appendFile(gi, `\n# wt\n${missing.join("\n")}\n`); notes.push(`.gitignore += ${missing.join(", ")}`); }

  // Changesets are meant to be committed, so this must be tracked rather than ignored:
  // seed it here so a new worktree inherits it instead of gaining an untracked db/.
  const keep = path.join(env.repoRoot, env.cfg.db.changes_dir, ".gitkeep");
  if (!existsSync(keep)) {
    await mkdir(path.dirname(keep), { recursive: true });
    await writeFile(keep, "");
    notes.push(`created ${path.relative(env.repoRoot, keep)} — commit it so worktrees start clean`);
  }

  const ddevCfgPath = path.join(env.repoRoot, ".ddev", "config.yaml");
  if (existsSync(ddevCfgPath)) {
    if (ddev.name) notes.push(`note: .ddev/config.yaml pins name: ${ddev.name}. That is fine — wt writes its own \`name:\` into each worktree's .ddev/config.wt.local.yaml, which DDEV merges on top. Just keep \`main: ${ddev.name}\` in ${CONFIG_FILE} in step with it.`);
    notes.push(...(await excludeWorktreesFromMutagen(env, ddev)));
  } else notes.push("no .ddev/config.yaml found — run `ddev config` in this checkout first");

  // The rule that decides *when* to take a worktree belongs in the repo, not in a
  // machine-local config: that is what survives a new machine and reaches teammates.
  const claudeMd = path.join(env.repoRoot, "CLAUDE.md");
  const claudeMdNotes = {
    present: "CLAUDE.md already carries the current wt worktree rule — left untouched",
    updated: 'CLAUDE.md: "Worktrees (wt)" section refreshed to the current rule — commit it',
    added: 'CLAUDE.md += "Worktrees (wt)" section — commit it: that is how the rule reaches other machines and other people',
  };
  notes.push(claudeMdNotes[await ensureClaudeMd(claudeMd, REPO_BLOCK)]);

  if (fw === "wordpress") notes.push("WordPress: add to wp-config.php before the settings block:  if (file_exists(__DIR__ . '/wp-config-wt.php')) require __DIR__ . '/wp-config-wt.php';");
  emit(env, { notes }, notes);
}
