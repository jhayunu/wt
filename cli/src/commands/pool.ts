import { planNew, planDestroy } from "../core/planner.js";
import { applySteps } from "../core/engine.js";
import { withRepoLock } from "../core/lock.js";
import { saveManifest } from "../core/config.js";
import { ddev } from "../core/ddev.js";
import { makeRecord } from "./new.js";
import { ctxFor, emit, type Env } from "../core/context.js";

/**
 * Warm pool: pre-built level-N environments on throwaway branches, stopped after
 * creation so they cost disk but no RAM. `wt new` claims one (rename + branch switch +
 * URL fixup) instead of cloning the DB, cutting creation from ~minute to seconds.
 */
function poolName(env: Env, i: number) { return `${env.cfg.pool.prefix}-${i.toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

export async function cmdPoolFill(env: Env, count?: number) {
  return withRepoLock(env.repoRoot, async () => {
    const have = Object.values(env.manifest.worktrees).filter((r) => r.pool).length;
    const want = count ?? Math.max(0, env.cfg.pool.size - have);
    const made: string[] = [];
    for (let i = 0; i < want; i++) {
      const name = poolName(env, have + i);
      const rec = makeRecord(env, name, `wt/${name}`, env.cfg.pool.level, {});
      rec.pool = true; rec.task = "(warm pool)";
      const ctx = ctxFor(env, rec);
      await applySteps(ctx, planNew(ctx, env.adapters, env.providers, { from: "HEAD", start: true }));
      await ddev.stop(env.run, name); // keep disk, free RAM
      if (!env.opts.dryRun) { env.manifest.worktrees[name] = rec; await saveManifest(env.repoRoot, env.manifest); }
      made.push(name);
    }
    emit(env, { filled: made, pool_size: have + made.length }, [made.length ? `pool +${made.length}: ${made.join(", ")}` : `pool already at ${have}`]);
  });
}

export async function cmdPoolLs(env: Env) {
  const rows = Object.values(env.manifest.worktrees).filter((r) => r.pool).map((r) => ({ name: r.name, level: r.level, media: r.media, db: r.db, age_h: Math.round((Date.now() - Date.parse(r.createdAt)) / 36e5) }));
  emit(env, { pool: rows }, rows.length ? rows.map((r) => `${r.name}\tL${r.level}\t${r.db}/${r.media}\t${r.age_h}h`) : ["pool empty"]);
}

export async function cmdPoolDrain(env: Env) {
  return withRepoLock(env.repoRoot, async () => {
    const names: string[] = [];
    for (const r of Object.values(env.manifest.worktrees).filter((r) => r.pool)) {
      await applySteps(ctxFor(env, r), planDestroy(ctxFor(env, r), false));
      if (!env.opts.dryRun) { delete env.manifest.worktrees[r.name]; await saveManifest(env.repoRoot, env.manifest); }
      names.push(r.name);
    }
    emit(env, { drained: names }, [names.length ? `drained: ${names.join(", ")}` : "pool empty"]);
  });
}
