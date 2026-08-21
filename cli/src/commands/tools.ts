import { getRecord, type Env } from "../core/context.js";
import { depHint, missingDeps, runTool } from "../core/deps.js";

/**
 * Tool passthroughs: `wt npm <name> …`, `wt artisan <name> …`, `wt wp <name> …`, etc.
 * Everything runs inside DDEV — never on the host.
 *
 *  level ≥ 2 : the worktree is its own DDEV project → `ddev <tool> …` with cwd = worktree.
 *  level 0/1 : the worktree has no containers → borrow main's web container with
 *              `ddev exec --dir /var/www/html/<rel> <tool> …` run from main's root.
 *              (Running `ddev <tool>` from inside the worktree would make DDEV treat it as a
 *              new project, because the checkout carries .ddev/config.yaml — so we never do that.)
 */
export const TOOLS = ["npm", "npx", "yarn", "pnpm", "node", "composer", "artisan", "wp", "php", "mysql", "drush"] as const;
export type Tool = (typeof TOOLS)[number];

export async function cmdTool(env: Env, tool: Tool, name: string, args: string[]) {
  const r = getRecord(env, name);
  const out = await runTool(env.run, env.repoRoot, r, tool, args);
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  // A missing vendor/ or node_modules/ fails deep inside the tool ("failed to open
  // stream: … autoload.php"), which reads as a broken worktree. Say what it actually is.
  if (out.exitCode !== 0) {
    const missing = missingDeps(r, env.adapters);
    if (missing.length) process.stderr.write(depHint(r, missing) + "\n");
  }
  process.exitCode = out.exitCode;
}
