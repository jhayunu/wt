import { planPromote } from "../core/planner.js";
import { applySteps, describePlan } from "../core/engine.js";
import { withRepoLock } from "../core/lock.js";
import { saveManifest } from "../core/config.js";
import { assertCanCreate, assertCanMutate } from "../core/policy.js";
import { ctxFor, emit, getRecord, type Env } from "../core/context.js";
import { LEVEL_NAMES, type Level, type MediaStrategy } from "../core/types.js";

export async function cmdPromote(env: Env, name: string, o: { level?: number; media?: MediaStrategy; force?: boolean }) {
  return withRepoLock(env.repoRoot, async () => {
    const rec = getRecord(env, name);
    assertCanMutate(env.cfg, rec, !!o.force);
    const to = (o.level ?? rec.level) as Level;
    assertCanCreate(env.cfg, to, rec.task ?? "promote");
    const before = { level: rec.level, media: rec.media };
    const ctx = ctxFor(env, rec);
    const steps = planPromote(ctx, env.adapters, env.providers, to, o.media);
    env.log(`promote ${name}: level ${before.level}→${to}${o.media ? `, media ${before.media}→${o.media}` : ""}`);
    env.log(`plan:\n  ${describePlan(steps).join("\n  ")}`);
    await applySteps(ctx, steps);
    if (!env.opts.dryRun) await saveManifest(env.repoRoot, env.manifest);
    emit(env, { worktree: rec, before, plan: describePlan(steps) },
      [`${name}: level ${before.level} (${LEVEL_NAMES[before.level]}) → ${rec.level} (${LEVEL_NAMES[rec.level]}), media ${before.media} → ${rec.media}`, rec.url]);
  });
}
