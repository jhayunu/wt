import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The rule that decides *when* an agent takes a worktree.
 *
 * It is written to two places on purpose, because they survive different things:
 * the repo's CLAUDE.md travels with the repository (new machine, new teammate),
 * and ~/.claude/CLAUDE.md covers every repo on this machine — including ones set
 * up before `wt init` ran. Both carry the same marker so re-running is a no-op.
 */
export const CLAUDE_MARKER = "<!-- wt:worktrees -->";

const PLAN_RULE =
  "**Decide at plan time.** If the plan involves editing files, running migrations or running a test suite, its first step is " +
  "`wt new <branch> --task \"<what the plan does>\"`, and everything after it happens inside `worktree.path`. Read-only work — " +
  "answering questions, reading code, reviewing a diff — stays in the main checkout. With no plan (a one-line ask that turns into " +
  "an edit), take the worktree before the first edit rather than after. State the choice in one line; do not ask permission.";

const SHARED_RULES = [
  "Never edit files or run migrations in the main checkout. Never run `ddev …` from inside a level 0/1 worktree — route tooling " +
  "through `wt npm|composer|artisan|wp|exec <name> …`, which lands in the right container either way. Before a PR: `wt db diff <name>`, " +
  "then `wt db export <name>` if it reports anything. When the work is merged or abandoned: `wt destroy <name>`.",
  "",
  "Worktrees owned by another agent are not yours to destroy or promote; `wt ls` shows who owns what.",
];

export const REPO_BLOCK = [
  CLAUDE_MARKER,
  "## Worktrees (wt)",
  "",
  "This repo uses `wt`: every branch gets its own worktree, and from isolation level 2 up its own DDEV environment (URL, database, media).",
  "",
  PLAN_RULE,
  "",
  ...SHARED_RULES,
  "",
].join("\n");

export const GLOBAL_BLOCK = [
  CLAUDE_MARKER,
  "## Worktrees (wt)",
  "",
  "In **any repo that has a `.wt.yml`**, `wt` gives each branch its own worktree and (from isolation level 2 up) its own DDEV environment. Repos without that file are unaffected — this rule stays silent there.",
  "",
  PLAN_RULE,
  "",
  ...SHARED_RULES,
  "",
].join("\n");

/** Append `block` to a CLAUDE.md unless its marker is already there. Returns what happened. */
export async function ensureClaudeMd(file: string, block: string): Promise<"added" | "present"> {
  const cur = existsSync(file) ? await readFile(file, "utf8") : "";
  if (cur.includes(CLAUDE_MARKER)) return "present";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, cur.trim() ? `${cur.trimEnd()}\n\n${block}` : `# Instructions\n\n${block}`);
  return "added";
}
