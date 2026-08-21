import path from "node:path";
import pc from "picocolors";
import { loadRepoConfig, loadManifest } from "./config.js";
import { realRunner, dryRunner } from "./proc.js";
import { repoRoot as findRoot } from "./git.js";
import { detectAdapters } from "../adapters/index.js";
import { resolveProviders } from "../providers/index.js";
import type { Ctx, Manifest, RepoConfig, Runner, WorktreeRecord, Adapter, DbChangeProvider } from "./types.js";
import { EXIT, WtError } from "./types.js";

export interface GlobalOpts { json?: boolean; dryRun?: boolean; quiet?: boolean }

export interface Env {
  repoRoot: string; cfg: RepoConfig; manifest: Manifest; run: Runner; log: (s: string) => void;
  adapters: Adapter[]; providers: DbChangeProvider[]; opts: GlobalOpts;
}

export async function loadEnv(opts: GlobalOpts): Promise<Env> {
  const log = (s: string) => { if (!opts.json && !opts.quiet) process.stderr.write(pc.dim(s) + "\n"); };
  const run = opts.dryRun ? dryRunner((s) => process.stderr.write(pc.yellow(s) + "\n")) : realRunner;
  const repoRoot = await findRoot(realRunner);
  const cfg = await loadRepoConfig(repoRoot);
  const manifest = await loadManifest(repoRoot);
  const adapters = await detectAdapters(repoRoot, cfg.framework);
  const providers = resolveProviders(cfg, adapters);
  return { repoRoot, cfg, manifest, run, log, adapters, providers, opts };
}

export function ctxFor(env: Env, rec: WorktreeRecord): Ctx {
  return { repoRoot: env.repoRoot, cfg: env.cfg, rec, dryRun: !!env.opts.dryRun, json: !!env.opts.json, log: env.log, run: env.run };
}

export function getRecord(env: Env, name: string): WorktreeRecord {
  const rec = env.manifest.worktrees[name];
  if (!rec) throw new WtError(EXIT.NOT_FOUND, `no worktree named "${name}"`, "run: wt ls");
  return rec;
}

export function worktreePath(env: Env, name: string) { return path.join(env.repoRoot, env.cfg.worktrees_dir, name); }

/** Uniform output: JSON on --json, otherwise human text. Always prints URL last on success. */
export function emit(env: Env, data: Record<string, unknown>, human: string[]) {
  if (env.opts.json) process.stdout.write(JSON.stringify({ ok: true, ...data }) + "\n");
  else process.stdout.write(human.join("\n") + "\n");
}
