import { existsSync } from "node:fs";
import path from "node:path";
import type { Adapter, Runner, WorktreeRecord } from "./types.js";

export interface Dependency { marker: string; tool: string; args: string[] }

/**
 * Dependency trees git does not carry: `vendor/`, `node_modules/`. A fresh worktree has
 * neither, and the resulting failure ("Failed to open stream: vendor/autoload.php") reads
 * as a broken worktree rather than a missing install — so name it explicitly.
 */
export function declaredDeps(adapters: Adapter[]): Dependency[] {
  const out: Dependency[] = [];
  for (const a of adapters) for (const d of a.dependencies?.() ?? []) {
    if (!out.some((x) => x.marker === d.marker)) out.push(d);
  }
  return out;
}

export function missingDeps(rec: WorktreeRecord, adapters: Adapter[]): Dependency[] {
  return declaredDeps(adapters).filter((d) => !existsSync(path.join(rec.path, d.marker)));
}

/** One line an agent can act on, in the same `wt <tool> <name> -- …` form it already uses. */
export function depHint(rec: WorktreeRecord, missing: Dependency[]): string {
  return `hint: ${rec.name} has no ${missing.map((d) => d.marker.split("/")[0]).join(" or ")} — run: ` +
    missing.map((d) => `wt ${d.tool} ${rec.name} -- ${d.args.join(" ")}`).join("  &&  ");
}

/**
 * How a tool call reaches the right container. Level ≥ 2 has its own project, so
 * `ddev <tool>` from the worktree; level 0/1 borrows main's web container at the
 * worktree's path under the project mount. Shared so `wt npm`, `wt exec` and the
 * `--install` creation step cannot drift apart.
 */
export function toolArgv(repoRoot: string, rec: WorktreeRecord, tool: string | null, args: string[]): { argv: string[]; cwd: string } {
  if (rec.level >= 2) return { argv: tool ? [tool, ...args] : ["exec", ...args], cwd: rec.path };
  const inContainer = path.posix.join("/var/www/html", path.relative(repoRoot, rec.path));
  // `artisan` is a DDEV shortcut for `php artisan`; inside `exec` we spell it out.
  const cmd = tool === null ? args : tool === "artisan" ? ["php", "artisan", ...args] : [tool, ...args];
  return { argv: ["exec", "--dir", inContainer, ...cmd], cwd: repoRoot };
}

export async function runTool(run: Runner, repoRoot: string, rec: WorktreeRecord, tool: string | null, args: string[], allowFail = true) {
  const { argv, cwd } = toolArgv(repoRoot, rec, tool, args);
  return run("ddev", argv, { cwd, allowFail });
}
