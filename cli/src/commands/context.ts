import path from "node:path";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ddevList } from "../core/ddev.js";
import { isOwner, leaseExpired } from "../core/policy.js";
import { emit, type Env } from "../core/context.js";
import { LEVEL_NAMES } from "../core/types.js";

/**
 * `wt context` — compact situational summary for an agent. Detects the worktree
 * from cwd when inside one. Designed to be injected by the UserPromptSubmit hook,
 * so it must stay short (a few hundred bytes) and stable.
 */
export async function cmdContext(env: Env, o: { all?: boolean }) {
  const cwd = process.cwd();
  const inside = Object.values(env.manifest.worktrees).find((r) => cwd === r.path || cwd.startsWith(r.path + path.sep));
  const live = await ddevList(env.run);
  const lines: string[] = [];
  const data: Record<string, unknown> = { repo: env.repoRoot, main: env.cfg.main, framework: env.adapters.map((a) => a.id) };

  if (inside) {
    const status = inside.level >= 2 ? (live.find((p) => p.name === inside.name)?.status ?? "stopped") : "n/a";
    const changes = path.join(inside.path, env.cfg.db.changes_dir);
    const pending = existsSync(changes) ? (await readdir(changes)).filter((d) => !d.startsWith(".")).length : 0;
    data.worktree = { ...inside, status, pending_changesets: pending, mine: isOwner(inside), lease_expired: leaseExpired(inside) };
    lines.push(
      `wt: inside worktree "${inside.name}" (branch ${inside.branch}, level ${inside.level} ${LEVEL_NAMES[inside.level]}, ${status})${inside.url ? ` → ${inside.url}` : ""}`,
      `   owner ${inside.owner}${isOwner(inside) ? " (you)" : ""}; db ${inside.db}, media ${inside.media}; ${pending} changeset dir(s) in ${env.cfg.db.changes_dir}`,
      inside.level >= 2
        ? `   tools: wt wp|artisan|npm|composer ${inside.name} … · before PR: wt db diff ${inside.name} && wt db export ${inside.name}`
        : `   tools: wt npm|composer|artisan ${inside.name} … (runs in main's container; never run ddev here)`,
    );
  } else {
    const inMain = cwd === env.repoRoot || cwd.startsWith(env.repoRoot + path.sep);
    lines.push(`wt: ${inMain ? "in MAIN checkout — do not edit here; " : ""}start with: wt --json new <branch> --task "…"`);
  }
  if (o.all || !inside) {
    const others = Object.values(env.manifest.worktrees).filter((r) => !r.pool && r !== inside);
    data.worktrees = others.map((r) => ({ name: r.name, branch: r.branch, level: r.level, owner: r.owner, url: r.url }));
    if (others.length) lines.push(`   other worktrees: ${others.map((r) => `${r.name}(L${r.level}, ${isOwner(r) ? "you" : r.owner})`).join(", ")}`);
    const pool = Object.values(env.manifest.worktrees).filter((r) => r.pool).length;
    if (pool) lines.push(`   warm pool: ${pool} ready`);
  }
  emit(env, data, lines);
}
