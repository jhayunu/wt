import type { Runner } from "./types.js";

export async function repoRoot(run: Runner, cwd = process.cwd()): Promise<string> {
  // If we're inside a worktree, --git-common-dir points at the main repo's .git
  const r = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  const common = r.stdout.trim();
  return common.endsWith("/.git") ? common.slice(0, -5) : common.replace(/\/\.git$/, "");
}

export async function branchExists(run: Runner, root: string, branch: string) {
  const r = await run("git", ["branch", "--list", branch], { cwd: root });
  return r.stdout.trim().length > 0;
}

export async function listWorktrees(run: Runner, root: string): Promise<{ path: string; branch?: string }[]> {
  const r = await run("git", ["worktree", "list", "--porcelain"], { cwd: root });
  const out: { path: string; branch?: string }[] = [];
  let cur: { path: string; branch?: string } | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9) }; out.push(cur); }
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "");
  }
  return out;
}

/** DNS-safe slug for DDEV project name: lowercase, [a-z0-9-], ≤ 63, no leading/trailing dash. */
export function slugify(branch: string): string {
  let s = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 50) {
    const hash = [...branch].reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 7).toString(36).slice(0, 6);
    s = `${s.slice(0, 43).replace(/-+$/, "")}-${hash}`;
  }
  return s || "wt";
}
