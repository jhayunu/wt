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
export const CLAUDE_MARKER_END = "<!-- /wt:worktrees -->";

const PLAN_RULE =
  "**Decide at plan time.** Take a worktree — `wt new <branch> --task \"<what the plan does>\"` as the first step, everything after " +
  "it inside `worktree.path` — when the work will **run** something (a test suite, a migration, the app itself) or spans more than " +
  "a file or two. Those are the cases that collide between sessions: a shared database, a bound port, a runner reading a " +
  "half-written file.\n\n" +
  "Stay in the main checkout for read-only work — answering questions, reading code, reviewing a diff — and for small, " +
  "self-contained edits that run nothing: a typo, a comment, a version bump, one line of config. Spinning up an environment to " +
  "change one line costs more than it protects.\n\n" +
  "When the case is clear-cut — a feature branch that will run migrations and a test suite — take the worktree, say so in one line " +
  "and carry on. When it is borderline, **ask before creating one**: a worktree the task did not need is an environment to tear " +
  "down, a branch to reap and a slot against `max_concurrent`. If a small edit grows a second file or needs a test run, take the " +
  "worktree at that point.";

const SHARED_RULES = [
  "Never run migrations or a test suite against the main checkout. Never run `ddev …` from inside a level 0/1 worktree — route tooling " +
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
  CLAUDE_MARKER_END,
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
  CLAUDE_MARKER_END,
  "",
].join("\n");

/**
 * Find the existing wt block in `cur`, as [start, end) offsets, or null if there is none.
 *
 * Blocks written before the end marker existed have only an opening one, and they were always
 * appended last — but a user may have added their own sections underneath since. So for those,
 * stop at the next heading after our own rather than swallowing the rest of the file.
 */
function findBlock(cur: string): [number, number] | null {
  const start = cur.indexOf(CLAUDE_MARKER);
  if (start === -1) return null;
  const end = cur.indexOf(CLAUDE_MARKER_END, start);
  if (end !== -1) return [start, end + CLAUDE_MARKER_END.length];
  const foreign = /^#{1,2} (?!Worktrees \(wt\))/m.exec(cur.slice(start));
  return [start, foreign ? start + foreign.index : cur.length];
}

/**
 * Write the wt rule into a CLAUDE.md: appended if absent, replaced in place if a previous
 * version is already there. Replacing matters because the rule gets tightened over time and
 * the old text would otherwise sit in every install that ran an earlier version.
 */
export async function ensureClaudeMd(file: string, block: string): Promise<"added" | "updated" | "present"> {
  const cur = existsSync(file) ? await readFile(file, "utf8") : "";
  const at = findBlock(cur);
  if (at) {
    const [start, end] = at;
    const tail = cur.slice(end);
    const replaced = `${cur.slice(0, start)}${block.trimEnd()}${tail.endsWith("\n") ? tail : `${tail}\n`}`;
    if (replaced === cur) return "present";
    await writeFile(file, replaced);
    return "updated";
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, cur.trim() ? `${cur.trimEnd()}\n\n${block}` : `# Instructions\n\n${block}`);
  return "added";
}
