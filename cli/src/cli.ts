#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { loadEnv, type GlobalOpts } from "./core/context.js";
import { WtError } from "./core/types.js";
import { cmdNew } from "./commands/new.js";
import { cmdLs, cmdUrl, cmdExec, cmdUp, cmdDown, cmdDestroy, cmdGc, cmdDoctor } from "./commands/misc.js";
import { cmdInit } from "./commands/init.js";
import { cmdSkillInstall } from "./commands/skill.js";
import { cmdTool, TOOLS } from "./commands/tools.js";
import { cmdPromote } from "./commands/promote.js";
import { cmdPoolFill, cmdPoolLs, cmdPoolDrain } from "./commands/pool.js";
import { cmdContext } from "./commands/context.js";
import { dbSnapshot, dbRestore, dbReset, dbDiff, dbExport, dbApply, dbStatus, dbSeed } from "./commands/db.js";
import { cmdClone } from "./commands/clone.js";

const program = new Command()
  .name("wt")
  .description("Per-worktree DDEV environments for AI agents (WordPress · Laravel · React)")
  .version("0.2.1")
  .option("--json", "machine-readable output")
  .option("--dry-run", "print the plan and commands without executing")
  .option("-q, --quiet", "suppress progress on stderr");

const g = (): GlobalOpts => program.opts<GlobalOpts>();
const wrap = (fn: (...a: any[]) => Promise<void>) => async (...a: any[]) => {
  try { await fn(...a); }
  catch (e) {
    const err = e as WtError;
    const code = typeof err.code === "number" ? err.code : 1;
    if (g().json) process.stdout.write(JSON.stringify({ ok: false, code, error: err.message, hint: err.hint }) + "\n");
    else process.stderr.write(pc.red(`error: ${err.message}`) + (err.hint ? pc.dim(`\n  hint: ${err.hint}`) : "") + "\n");
    process.exit(code);
  }
};

program.command("new <branch>")
  .description("create a worktree and its environment")
  .option("--from <ref>", "base ref when creating a new branch (default: main checkout's current branch)")
  .option("-l, --level <n>", "isolation level 0-4 (default: inferred)", (v) => Number(v))
  .option("-t, --task <text>", "what the agent will do; used to infer level")
  .option("--db <strategy>", "snapshot | dump | seedfile | fresh | none")
  .option("--media <strategy>", "symlink | copy | none")
  .option("--name <slug>", "override DDEV project / directory name")
  .option("--no-start", "create worktree + config but do not start containers")
  .option("--install", "run composer install / npm ci in the new worktree (minutes on a large repo)")
  .option("--pool", "require claiming from the warm pool (fail if none)")
  .option("--no-pool", "never claim from the warm pool")
  .action(wrap(async (branch, o) => cmdNew(await loadEnv(g()), branch, { from: o.from, level: o.level, task: o.task, db: o.db, media: o.media, noStart: o.start === false, name: o.name, pool: o.pool === true, noPool: o.pool === false, install: o.install })));

program.command("promote <name>").description("change isolation level / media mode in place")
  .option("-l, --level <n>", "target level", (v) => Number(v))
  .option("--media <mode>", "symlink | copy | proxy | none")
  .option("--force", "override ownership lease")
  .action(wrap(async (n, o) => cmdPromote(await loadEnv(g()), n, o)));

program.command("context").description("compact situational summary for agents (detects worktree from cwd)")
  .option("--all", "include other worktrees")
  .action(wrap(async (o) => cmdContext(await loadEnv(g()), o)));

const pool = program.command("pool").description("warm pool of pre-built environments");
pool.command("fill [count]").description("create pool entries (default: up to .wt.yml pool.size)").action(wrap(async (c) => cmdPoolFill(await loadEnv(g()), c === undefined ? undefined : Number(c))));
pool.command("ls").action(wrap(async () => cmdPoolLs(await loadEnv(g()))));
pool.command("drain").description("destroy all pool entries").action(wrap(async () => cmdPoolDrain(await loadEnv(g()))));

program.command("clone <git-url> [dir]").description("clone a repo and set it up for wt (init + ddev start)")
  .option("--no-start", "do not start DDEV").option("--seed", "also refresh the seed DB after start")
  .action(wrap(async (u, d, o) => cmdClone(u, d, { noStart: o.start === false, seed: o.seed, json: g().json })));
program.command("init").description("write .wt.yml + .gitignore entries for this repo").action(wrap(async () => cmdInit(await loadEnv(g()))));
program.command("ls").description("list worktrees").action(wrap(async () => cmdLs(await loadEnv(g()))));
program.command("url <name>").description("print primary URL").action(wrap(async (n) => cmdUrl(await loadEnv(g()), n)));
program.command("exec <name> [args...]").description("run a command in the worktree's web container").allowUnknownOption().allowExcessArguments()
  .action(wrap(async (n, args) => cmdExec(await loadEnv(g()), n, args)));
for (const t of TOOLS) {
  program.command(`${t} <name> [args...]`).description(`ddev ${t} inside the worktree (use -- before flags)`)
    .allowUnknownOption().allowExcessArguments()
    .action(wrap(async (n, args) => cmdTool(await loadEnv(g()), t, n, args)));
}
program.command("up <name>").description("ddev start").action(wrap(async (n) => cmdUp(await loadEnv(g()), n)));
program.command("down <name>").description("ddev stop").action(wrap(async (n) => cmdDown(await loadEnv(g()), n)));
program.command("destroy <name>").description("remove environment, worktree and (by default) branch")
  .option("--keep-branch", "do not delete the git branch")
  .option("--force", "destroy even if owned by someone else with an active lease")
  .action(wrap(async (n, o) => cmdDestroy(await loadEnv(g()), n, { keepBranch: o.keepBranch, force: o.force })));
program.command("gc").description("remove stale or merged worktrees")
  .option("--older-than <dur>", "e.g. 12h, 7d").option("--merged", "remove worktrees whose branch is merged into HEAD")
  .option("--prune", "also run `docker builder prune -f` (affects every project on this machine)")
  .action(wrap(async (o) => cmdGc(await loadEnv(g()), o)));
program.command("doctor [name]").description("check DDEV, DNS, config and (optionally) one worktree's health")
  .action(wrap(async (n) => cmdDoctor(await loadEnv(g()), n)));

const skill = program.command("skill").description("Claude Code integration");
skill.command("install").description("copy the wt skill into ~/.claude/skills (or --project)")
  .option("--project", "install into this repo's .claude/skills instead of ~")
  .option("--no-claude-md", "do not add the \"when to take a worktree\" rule to CLAUDE.md")
  .action(wrap(async (o) => cmdSkillInstall(await loadEnv(g()), o)));

const db = program.command("db").description("database snapshots and change tracking");
db.command("snapshot <name> [snap]").action(wrap(async (n, s) => dbSnapshot(await loadEnv(g()), n, s)));
db.command("restore <name> [snap]").action(wrap(async (n, s) => dbRestore(await loadEnv(g()), n, s)));
db.command("reset <name>").description("restore the creation snapshot").action(wrap(async (n) => dbReset(await loadEnv(g()), n)));
db.command("diff <name>").description("what changed in the DB since baseline").action(wrap(async (n) => dbDiff(await loadEnv(g()), n)));
db.command("export <name> [slug]").description("write the DB delta as versionable files into db/changes/").action(wrap(async (n, s) => dbExport(await loadEnv(g()), n, s)));
db.command("apply <name> [dir]").description("replay committed changesets onto this worktree's DB (idempotent via ledger)")
  .option("--force", "re-apply even if the ledger says it was applied")
  .action(wrap(async (n, d, o) => dbApply(await loadEnv(g()), n, d, o)));
db.command("seed").description("refresh the shared seed dump (db: seedfile) from main or `ddev pull`")
  .option("--from <mode>", "ddev-pull | export-main")
  .action(wrap(async (o) => dbSeed(await loadEnv(g()), o)));
db.command("status <name>").action(wrap(async (n) => dbStatus(await loadEnv(g()), n)));

program.parseAsync(process.argv);
