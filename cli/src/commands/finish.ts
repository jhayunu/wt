import path from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { ctxFor, emit, getRecord, type Env } from "../core/context.js";
import { withRepoLock } from "../core/lock.js";
import { assertCanDestroy } from "../core/policy.js";
import { currentRef } from "../core/git.js";
import { EXIT, WtError } from "../core/types.js";
import { cmdDestroy } from "./misc.js";

export interface FinishOpts { confirm?: boolean; force?: boolean; keepBranch?: boolean; noFf?: boolean; skipDbCheck?: boolean; into?: string }

const dirty = async (env: Env, cwd: string) =>
  (await env.run("git", ["status", "--porcelain"], { cwd, allowFail: true })).stdout.trim();

/**
 * Merge a finished worktree back into the branch it came from, then destroy it.
 *
 * Refuses by default and prints the plan instead: this deletes a branch, an
 * environment and a database, and `wt` must never prompt (an interactive question
 * hangs an agent forever). `--confirm` is the gate.
 *
 * Database content is deliberately NOT applied to main. An exported changeset is
 * committed with the branch and a human applies it — see `wt db apply`. What
 * `finish` does do is refuse to destroy a worktree whose database changes were
 * never exported, because destroying it drops the database for good.
 */
export async function cmdFinish(env: Env, name: string, o: FinishOpts) {
  return withRepoLock(env.repoRoot, async () => {
    const rec = getRecord(env, name);
    assertCanDestroy(env.cfg, rec, !!o.force); // finishing implies destroying
    if (rec.pool) throw new WtError(EXIT.GENERIC, `"${name}" is a pool entry, not a task worktree`, "wt pool drain");

    const into = o.into ?? rec.from;
    if (!into) throw new WtError(EXIT.GENERIC, `no source branch recorded for "${name}"`, "pass --into <branch> (worktrees created before wt 0.2.2 do not record it)");

    const blockers: string[] = [];

    // 1. the worktree must have nothing uncommitted — merging would silently drop it
    const wtDirty = await dirty(env, rec.path);
    if (wtDirty) blockers.push(`"${name}" has uncommitted changes (${wtDirty.split("\n").length} file(s)) — commit or stash them first`);

    // 2. the main checkout must already be on the target branch. Switching it from under a
    //    human (or another agent) is exactly the kind of surprise this tool exists to avoid.
    //    Its cleanliness is deliberately NOT checked: `git merge` refuses on its own if the
    //    merge would overwrite local changes, and DDEV edits wp-config.php by itself, so a
    //    blanket check would block merges that are perfectly safe.
    const head = await currentRef(env.run, env.repoRoot);
    if (head !== into) blockers.push(`the main checkout is on "${head}", not "${into}" — run: git checkout ${into}`);

    // 3. anything to merge?
    const ahead = (await env.run("git", ["rev-list", "--count", `${into}..${rec.branch}`], { cwd: env.repoRoot, allowFail: true })).stdout.trim();
    const commits = Number(ahead) || 0;

    // 4. unexported database changes would be destroyed along with the worktree
    let dbPending: Record<string, number> = {};
    if (rec.level >= 2 && !o.skipDbCheck) {
      for (const p of env.providers) {
        try {
          const cs = await p.diff(ctxFor(env, rec));
          if (!cs.empty) dbPending = { ...dbPending, ...cs.data };
        } catch { /* no baseline / provider not applicable — nothing to protect */ }
      }
      const changesRoot = path.join(rec.path, env.cfg.db.changes_dir);
      const exported = existsSync(changesRoot) && (await readdir(changesRoot)).some((d) => !d.startsWith("."));
      if (Object.keys(dbPending).length && !exported)
        blockers.push(`"${name}" has database changes and nothing was ever exported (${Object.entries(dbPending).map(([t, n]) => `${t}: ${n}`).join(", ")}) — run: wt db export ${name}, commit it, then finish again (or pass --skip-db-check to discard them)`);
    }

    const plan = [
      `git merge ${o.noFf === false ? "" : "--no-ff "}${rec.branch}   # into ${into}`,
      ...(o.keepBranch ? [] : [`git branch -D ${rec.branch}`]),
      `wt destroy ${name}   # ddev project, worktree, generated files, database`,
    ];

    if (blockers.length) {
      throw new WtError(EXIT.DIRTY, `cannot finish "${name}":\n  - ${blockers.join("\n  - ")}`, "fix the above, then re-run");
    }

    if (!o.confirm) {
      emit(env, { would_merge: rec.branch, into, commits, plan, db_pending: dbPending, confirmed: false },
        [`finish ${name} → ${into} (${commits} commit(s))`, ...plan.map((p) => `  ${p}`), "",
         "nothing has changed. re-run with --confirm to do it."]);
      return;
    }

    if (commits > 0) {
      const m = await env.run("git", ["merge", ...(o.noFf === false ? [] : ["--no-ff"]), "-m", `Merge ${rec.branch}${rec.task ? ` — ${rec.task}` : ""}`, rec.branch],
        { cwd: env.repoRoot, allowFail: true });
      if (m.exitCode !== 0) {
        // Leaving a half-merged repo behind is no good for an agent that cannot be asked
        // to resolve it, and no good for a human who did not choose to start a merge.
        // Abort, restore the previous state, and hand the conflict back as a plain error.
        await env.run("git", ["merge", "--abort"], { cwd: env.repoRoot, allowFail: true });
        const files = [...m.stdout.matchAll(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/gm)].map((x) => x[1]);
        throw new WtError(EXIT.DIRTY,
          `merging ${rec.branch} into ${into} conflicts${files.length ? ` in: ${files.join(", ")}` : ""} — nothing was merged or destroyed`,
          `resolve it by hand: git merge ${rec.branch}, fix the conflict, commit, then: wt destroy ${name}`);
      }
    } else {
      env.log(`nothing to merge (${rec.branch} is not ahead of ${into})`);
    }

    // Destroy last: a failed merge must leave the worktree intact so the work is recoverable.
    await cmdDestroy(env, name, { keepBranch: o.keepBranch, force: o.force });
    emit(env, { finished: name, into, commits, merged: commits > 0 },
      [`merged ${rec.branch} into ${into} (${commits} commit(s)) and destroyed ${name}`,
       `  changesets, if any, are committed on ${into} — apply them with: wt db apply <worktree>`]);
  });
}
