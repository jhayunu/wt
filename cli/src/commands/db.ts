import path from "node:path";
import { ddev } from "../core/ddev.js";
import { saveManifest } from "../core/config.js";
import { ctxFor, emit, getRecord, type Env } from "../core/context.js";
import { EXIT, WtError, type ChangeSet } from "../core/types.js";

function requireLevel2(env: Env, name: string) {
  const r = getRecord(env, name);
  if (r.level < 2) throw new WtError(EXIT.GENERIC, `"${name}" is level ${r.level}; no database of its own`, "wt promote <name> --level 2");
  return r;
}

export async function dbSnapshot(env: Env, name: string, snap?: string) {
  const r = requireLevel2(env, name);
  const s = snap ?? `wt-${Date.now()}`;
  await ddev.snapshot(env.run, r.path, s);
  r.snapshots.push(s);
  // without this the name is lost when the process exits, and `wt db restore <name>` finds nothing
  if (!env.opts.dryRun) await saveManifest(env.repoRoot, env.manifest);
  emit(env, { snapshot: s }, [`snapshot ${s}`]);
}

export async function dbRestore(env: Env, name: string, snap?: string) {
  const r = requireLevel2(env, name);
  const s = snap ?? r.snapshots.at(-1);
  if (!s) throw new WtError(EXIT.GENERIC, "no snapshot recorded", `wt db snapshot ${name}`);
  await ddev.snapshotRestore(env.run, r.path, s);
  emit(env, { restored: s }, [`restored ${s}`]);
}

export async function dbReset(env: Env, name: string) {
  const r = requireLevel2(env, name);
  const s = r.snapshots[0];
  if (!s) throw new WtError(EXIT.GENERIC, "no creation snapshot");
  await ddev.snapshotRestore(env.run, r.path, s);
  await ddev.start(env.run, r.path); // re-run post-start hooks (URL fixups)
  emit(env, { reset_to: s }, [`reset to ${s}`]);
}

export async function dbDiff(env: Env, name: string) {
  const r = requireLevel2(env, name);
  const out: ChangeSet[] = [];
  for (const p of env.providers) out.push(await p.diff(ctxFor(env, r)));
  const empty = out.every((c) => c.empty);
  emit(env, { empty, changesets: out }, empty ? ["no database changes since baseline"] :
    out.flatMap((c) => [`[${c.provider}]`, ...c.schema.map((s) => `  ${s}`), ...Object.entries(c.data).map(([t, n]) => `  ${t}: ${n} row(s) changed`)]));
}

export async function dbExport(env: Env, name: string, slug?: string) {
  const r = requireLevel2(env, name);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dir = path.join(r.path, env.cfg.db.changes_dir, `${stamp}-${slug ?? r.name}`);
  const files: string[] = [];
  for (const p of env.providers) {
    const cs = await p.diff(ctxFor(env, r));
    if (cs.empty) continue;
    files.push(...(await p.export(ctxFor(env, r), cs, path.join(dir, p.id))));
  }
  emit(env, { dir, files }, files.length ? [`exported ${files.length} file(s) to ${path.relative(r.path, dir)}`, "commit them with your branch; reviewers apply with: wt db apply <name>"] : ["nothing to export"]);
}

export async function dbApply(env: Env, name: string, dirArg?: string, o: { force?: boolean } = {}) {
  const r = requireLevel2(env, name);
  const ctx = ctxFor(env, r);
  const root = path.join(r.path, env.cfg.db.changes_dir);
  const { readdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { ensureLedger, listApplied, markApplied } = await import("../providers/ledger.js");
  const dirs = dirArg ? [path.resolve(dirArg)] : (existsSync(root) ? (await readdir(root)).filter((d) => !d.startsWith(".")).sort().map((d) => path.join(root, d)) : []);
  if (!env.opts.dryRun) await ensureLedger(ctx);
  const done = env.opts.dryRun ? new Set<string>() : await listApplied(ctx);
  const applied: string[] = [], skipped: string[] = [];
  for (const d of dirs) for (const p of env.providers) {
    const pd = path.join(d, p.id);
    if (!existsSync(pd)) continue;
    const key = `${path.basename(d)}/${p.id}`;
    if (done.has(key) && !o.force) { skipped.push(key); continue; }
    await p.apply(ctx, pd);
    if (!env.opts.dryRun) await markApplied(ctx, path.basename(d), p.id);
    applied.push(key);
  }
  emit(env, { applied, skipped }, [`applied ${applied.length}, skipped ${skipped.length} (already applied)`]);
}

export async function dbStatus(env: Env, name: string) {
  const r = requireLevel2(env, name);
  const res: Record<string, unknown> = {};
  for (const p of env.providers) res[p.id] = await p.status(ctxFor(env, r));
  emit(env, { status: res }, Object.entries(res).map(([k, v]) => `${k}: ${JSON.stringify(v)}`));
}

/** Refresh the shared seed file used by `db: seedfile` worktrees. Decouples creation from main being up. */
export async function dbSeed(env: Env, o: { from?: "ddev-pull" | "export-main" }) {
  const mode = o.from ?? env.cfg.seed.refresh;
  const file = path.join(env.repoRoot, env.cfg.seed.file);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
  if (mode === "ddev-pull") {
    await env.run("ddev", ["pull", env.cfg.seed.pull_env, "-y", "--skip-files"], { cwd: env.repoRoot });
    await env.run("ddev", ["export-db", "--file", file], { cwd: env.repoRoot });
  } else if (mode === "export-main") {
    await env.run("ddev", ["export-db", "--file", file], { cwd: env.repoRoot });
  } else throw new WtError(EXIT.GENERIC, "seed.refresh is 'none' — provide the file manually", `place a dump at ${env.cfg.seed.file}`);
  emit(env, { seed: file, mode }, [`seed refreshed (${mode}): ${path.relative(env.repoRoot, file)}`]);
}
