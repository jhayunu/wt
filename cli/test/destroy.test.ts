import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir } from "node:fs/promises";
import { planDestroy } from "../src/core/planner.js";
import { applySteps } from "../src/core/engine.js";
import { RepoConfigSchema } from "../src/core/config.js";
import type { Ctx, RunResult } from "../src/core/types.js";

/** Fake runner that mimics the real one: fails `git worktree remove`, honours allowFail. */
function runnerThatCannotRemove(calls: string[][]) {
  return async (cmd: string, args: string[], opts?: { allowFail?: boolean }): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    const failing = cmd === "git" && args[0] === "worktree" && args[1] === "remove";
    if (!failing) return { stdout: "", stderr: "", exitCode: 0 };
    const res = { stdout: "", stderr: "fatal: 'x' is not a working tree", exitCode: 128 };
    if (!opts?.allowFail) throw new Error(res.stderr);
    return res;
  };
}

async function ctxFor(worktreePath: string, calls: string[][]): Promise<Ctx> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wt-destroy-"));
  return {
    repoRoot,
    cfg: RepoConfigSchema.parse({ main: "m" }),
    rec: { name: "gone", branch: "feat/gone", level: 0, path: worktreePath, createdFiles: [] } as Ctx["rec"],
    dryRun: false,
    json: false,
    log: () => {},
    run: runnerThatCannotRemove(calls),
  };
}

test("destroy is idempotent when the worktree directory is already gone", async () => {
  const calls: string[][] = [];
  const ctx = await ctxFor(path.join(os.tmpdir(), "wt-destroy-no-such-tree"), calls);

  await applySteps(ctx, planDestroy(ctx, true));

  assert.ok(calls.some((c) => c.join(" ").startsWith("git worktree prune")),
    "a vanished directory leaves a stale admin entry — prune must clear it");
});

test("destroy still fails when the worktree directory is present", async () => {
  const calls: string[][] = [];
  const live = path.join(await mkdtemp(path.join(os.tmpdir(), "wt-live-")), "tree");
  await mkdir(live);
  const ctx = await ctxFor(live, calls);

  await assert.rejects(() => applySteps(ctx, planDestroy(ctx, true)), /not a working tree/,
    "a removal that fails with the tree still on disk is a real error, not something to swallow");
});
