import type { Ctx, Step } from "./types.js";

/**
 * Plan/apply executor. Runs steps in order; on failure, runs `down` of the
 * already-completed steps in reverse so a half-built environment never
 * survives. This is the single most important property for unattended agents.
 */
export async function applySteps(ctx: Ctx, steps: Step[]): Promise<void> {
  const done: Step[] = [];
  for (const s of steps) {
    ctx.log(`→ ${s.title}`);
    try {
      await s.up(ctx);
      done.push(s);
    } catch (err) {
      if (s.optional) { ctx.log(`! ${s.title}: ${(err as Error).message} (optional — continuing)`); continue; }
      ctx.log(`✗ ${s.title}: ${(err as Error).message}`);
      ctx.log(`rolling back ${done.length} step(s)…`);
      for (const d of done.reverse()) {
        if (!d.down) continue;
        try { await d.down(ctx); ctx.log(`  ↩ ${d.title}`); }
        catch (e) { ctx.log(`  ! rollback of "${d.title}" failed: ${(e as Error).message}`); }
      }
      throw err;
    }
  }
}

export function describePlan(steps: Step[]): string[] {
  return steps.map((s, i) => `${i + 1}. ${s.title}`);
}
