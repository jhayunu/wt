import path from "node:path";
import { getRecord, type Env } from "../core/context.js";

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
  let out;
  if (r.level >= 2) {
    out = await env.run("ddev", [tool, ...args], { cwd: r.path, allowFail: true });
  } else {
    const inContainer = path.posix.join("/var/www/html", path.relative(env.repoRoot, r.path));
    // `artisan` is a DDEV shortcut for `php artisan`; inside exec we spell it out.
    const cmd = tool === "artisan" ? ["php", "artisan", ...args] : [tool, ...args];
    out = await env.run("ddev", ["exec", "--dir", inContainer, ...cmd], { cwd: env.repoRoot, allowFail: true });
  }
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}
