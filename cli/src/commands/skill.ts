import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emit, type Env } from "../core/context.js";

/** Copy the bundled Claude Code skill to ~/.claude/skills/wt (or --project → ./.claude/skills/wt). */
export async function cmdSkillInstall(env: Env, o: { project?: boolean }) {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "wt");
  const dst = o.project ? path.join(env.repoRoot, ".claude", "skills", "wt") : path.join(os.homedir(), ".claude", "skills", "wt");
  if (!existsSync(src)) throw new Error(`bundled skill not found at ${src}`);
  await mkdir(path.dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true, force: true });
  emit(env, { installed: dst }, [`skill installed: ${dst}`, "restart Claude Code (or /reload) to pick it up"]);
}
