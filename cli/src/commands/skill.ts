import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emit, type Env } from "../core/context.js";
import { ensureClaudeMd, GLOBAL_BLOCK, REPO_BLOCK } from "../core/claudemd.js";

/** Copy the bundled Claude Code skill to ~/.claude/skills/wt (or --project → ./.claude/skills/wt). */
export async function cmdSkillInstall(env: Env, o: { project?: boolean; claudeMd?: boolean }) {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "wt");
  const dst = o.project ? path.join(env.repoRoot, ".claude", "skills", "wt") : path.join(os.homedir(), ".claude", "skills", "wt");
  if (!existsSync(src)) throw new Error(`bundled skill not found at ${src}`);
  await mkdir(path.dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true, force: true });

  // A skill only fires once a task is under way. The rule about *when* to take a
  // worktree has to be in CLAUDE.md, which is read before anything else — so seed it
  // here too, machine-wide for a user install and repo-local for --project.
  const lines = [`skill installed: ${dst}`];
  const mdFile = o.project ? path.join(env.repoRoot, "CLAUDE.md") : path.join(os.homedir(), ".claude", "CLAUDE.md");
  let claudeMd: string | undefined;
  if (o.claudeMd !== false) {
    const what = await ensureClaudeMd(mdFile, o.project ? REPO_BLOCK : GLOBAL_BLOCK);
    claudeMd = mdFile;
    lines.push({
      present: `${mdFile}: worktree rule already current`,
      updated: `${mdFile}: worktree rule refreshed in place`,
      added: `${mdFile} += "Worktrees (wt)" rule (applies to any repo with a .wt.yml)`,
    }[what]);
  }
  lines.push("restart Claude Code (or /reload) to pick it up");
  emit(env, { installed: dst, claude_md: claudeMd }, lines);
}
