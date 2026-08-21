import { existsSync } from "node:fs";
import { ddevList, ddevAvailable } from "../core/ddev.js";
import { slugify } from "../core/git.js";
import { inferLevel, planNew, planPoolClaim } from "../core/planner.js";
import { applySteps, describePlan } from "../core/engine.js";
import { withRepoLock } from "../core/lock.js";
import { currentOwner, saveManifest } from "../core/config.js";
import { assertCanCreate, newLease } from "../core/policy.js";
import { frameworkOf } from "../adapters/index.js";
import { ctxFor, emit, worktreePath, type Env } from "../core/context.js";
import { EXIT, LEVEL_NAMES, WtError, type DbStrategy, type MediaStrategy, type WorktreeRecord } from "../core/types.js";

export interface NewOpts { from: string; level?: number; task?: string; db?: DbStrategy; media?: MediaStrategy; noStart?: boolean; name?: string; pool?: boolean; noPool?: boolean }

export function makeRecord(env: Env, name: string, branch: string, level: number, o: Partial<NewOpts>): WorktreeRecord {
  const lv = level as WorktreeRecord["level"];
  return {
    name, branch, path: worktreePath(env, name), level: lv, framework: frameworkOf(env.adapters),
    db: lv >= 2 ? (o.db ?? (lv === 4 ? "fresh" : env.cfg.defaults.db)) : "none",
    media: lv >= 2 ? (o.media ?? (lv >= 3 ? "copy" : lv === 4 ? "none" : env.cfg.defaults.media)) : "none",
    url: lv >= 2 ? `https://${name}.${env.cfg.tld}` : "",
    createdAt: new Date().toISOString(), owner: currentOwner(), leaseUntil: newLease(env.cfg),
    task: o.task, createdFiles: [], snapshots: [],
  };
}

export function liveCount(env: Env) { return Object.values(env.manifest.worktrees).filter((r) => !r.pool).length; }

export async function cmdNew(env: Env, branch: string, o: NewOpts) {
  return withRepoLock(env.repoRoot, async () => {
    const name = slugify(o.name ?? branch);
    if (env.manifest.worktrees[name]) throw new WtError(EXIT.NAME_CLASH, `worktree "${name}" already exists`, `wt url ${name}`);
    if (liveCount(env) >= env.cfg.max_concurrent) throw new WtError(EXIT.LIMIT, `max_concurrent=${env.cfg.max_concurrent} reached`, "wt gc --merged  or  wt destroy <name>");

    const { level, reasons } = inferLevel(env.cfg, env.adapters, o.level, o.task);
    assertCanCreate(env.cfg, level, o.task);
    if (level >= 2) {
      if (!(await ddevAvailable(env.run))) throw new WtError(EXIT.DDEV_MISSING, "ddev not found on PATH");
      if ((await ddevList(env.run)).some((p) => p.name === name)) throw new WtError(EXIT.NAME_CLASH, `a DDEV project named "${name}" already exists`, "pick --name <other>");
    }
    if (existsSync(worktreePath(env, name))) throw new WtError(EXIT.NAME_CLASH, `path exists: ${worktreePath(env, name)}`);

    const rec = makeRecord(env, name, branch, level, o);
    const ctx = ctxFor(env, rec);

    // Warm pool: claim an idle entry when it matches level/db/media and caller didn't opt out.
    const poolEntry = !o.noPool && !o.noStart && level >= 2
      ? Object.values(env.manifest.worktrees).find((r) => r.pool && r.level === level && r.media === rec.media && r.db === rec.db)
      : undefined;

    let steps;
    if (poolEntry) {
      steps = planPoolClaim(ctx, env.adapters, env.providers, poolEntry, o.from);
      reasons.push(`claimed from warm pool (${poolEntry.name})`);
    } else {
      if (o.pool) throw new WtError(EXIT.NOT_FOUND, "no matching pool entry available", "wt pool fill 1");
      steps = planNew(ctx, env.adapters, env.providers, { from: o.from, start: !o.noStart });
    }
    env.log(`level ${level} (${LEVEL_NAMES[level]}): ${reasons.join("; ")}`);
    env.log(`plan:\n  ${describePlan(steps).join("\n  ")}`);

    await applySteps(ctx, steps);

    if (!env.opts.dryRun) {
      if (poolEntry) delete env.manifest.worktrees[poolEntry.name];
      env.manifest.worktrees[name] = rec;
      await saveManifest(env.repoRoot, env.manifest);
    }

    const next = [
      `cd ${rec.path}`,
      level >= 2 ? `wt wp|artisan|npm|composer ${name} …   # tools run inside this worktree's containers` : `wt npm|composer|artisan ${name} …   # runs in main's web container`,
      level >= 2 ? `wt db diff ${name}   # before opening a PR, then: wt db export ${name}` : "",
      `wt destroy ${name}   # when done`,
    ].filter(Boolean);
    emit(env, { worktree: rec, level_reasons: reasons, plan: describePlan(steps), next_steps: next, dry_run: !!env.opts.dryRun },
      [`created ${name} (level ${level} ${LEVEL_NAMES[level]}, ${rec.framework}, owner ${rec.owner}) at ${rec.path}`, ...next.map((n) => `  ${n}`), rec.url]);
  });
}
