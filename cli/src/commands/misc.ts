import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ddevList, ddev, ddevStatus } from "../core/ddev.js";
import { applySteps } from "../core/engine.js";
import { planDestroy } from "../core/planner.js";
import { withRepoLock } from "../core/lock.js";
import { saveManifest } from "../core/config.js";
import { ctxFor, emit, getRecord, type Env } from "../core/context.js";
import { EXIT, LEVEL_NAMES, WtError } from "../core/types.js";
import { assertCanDestroy, isOwner } from "../core/policy.js";
import { depHint, missingDeps, runTool } from "../core/deps.js";

export async function cmdLs(env: Env) {
  const live = await ddevList(env.run);
  const rows = Object.values(env.manifest.worktrees).filter((r) => !r.pool).map((r) => ({
    name: r.name, branch: r.branch, level: r.level, framework: r.framework, owner: isOwner(r) ? "you" : r.owner,
    status: r.level >= 2 ? (live.find((p) => p.name === r.name)?.status ?? "stopped") : "n/a",
    url: r.url, age_h: Math.round((Date.now() - Date.parse(r.createdAt)) / 36e5), task: r.task ?? "",
  }));
  emit(env, { worktrees: rows }, rows.length
    ? [["NAME", "LVL", "FW", "STATUS", "OWNER", "AGE", "URL"].join("\t"), ...rows.map((r) => [r.name, `${r.level}/${LEVEL_NAMES[r.level]}`, r.framework, r.status, r.owner, `${r.age_h}h`, r.url].join("\t"))]
    : ["no worktrees"]);
}

export async function cmdUrl(env: Env, name: string) {
  const r = getRecord(env, name);
  emit(env, { url: r.url, path: r.path }, [r.url || `(level ${r.level}: no URL) ${r.path}`]);
}

export async function cmdExec(env: Env, name: string, args: string[]) {
  const r = getRecord(env, name);
  const out = await runTool(env.run, env.repoRoot, r, null, args);
  process.stdout.write(out.stdout); process.stderr.write(out.stderr);
  if (out.exitCode !== 0) {
    const missing = missingDeps(r, env.adapters);
    if (missing.length) process.stderr.write(depHint(r, missing) + "\n");
  }
  process.exitCode = out.exitCode;
}

export async function cmdUp(env: Env, name: string) {
  const r = getRecord(env, name);
  if (r.level < 2) throw new WtError(EXIT.GENERIC, `level ${r.level} worktrees have no containers`);
  await ddev.start(env.run, r.path);
  emit(env, { url: r.url }, [r.url]);
}

export async function cmdDown(env: Env, name: string) {
  const r = getRecord(env, name);
  if (r.level >= 2) await ddev.stop(env.run, r.name);
  emit(env, { stopped: r.name }, [`stopped ${r.name}`]);
}

export async function cmdDestroy(env: Env, name: string, o: { keepBranch?: boolean; force?: boolean }) {
  return withRepoLock(env.repoRoot, async () => {
    const r = getRecord(env, name);
    assertCanDestroy(env.cfg, r, !!o.force);
    await applySteps(ctxFor(env, r), planDestroy(ctxFor(env, r), !!o.keepBranch));
    if (!env.opts.dryRun) { delete env.manifest.worktrees[name]; await saveManifest(env.repoRoot, env.manifest); }
    emit(env, { destroyed: name }, [`destroyed ${name}`]);
  });
}

export async function cmdGc(env: Env, o: { olderThan?: string; merged?: boolean; prune?: boolean }) {
  const hours = o.olderThan ? parseDuration(o.olderThan) : Infinity;
  const victims: string[] = [];
  for (const r of Object.values(env.manifest.worktrees)) {
    if (r.pool) continue;
    const age = (Date.now() - Date.parse(r.createdAt)) / 36e5;
    let merged = false;
    if (o.merged) {
      const out = await env.run("git", ["branch", "--merged", "HEAD", "--list", r.branch], { cwd: env.repoRoot, allowFail: true });
      merged = out.stdout.trim().length > 0;
    }
    if (age > hours || merged) victims.push(r.name);
  }
  for (const v of victims) await cmdDestroy(env, v, { keepBranch: !o.merged, force: false }).catch((e) => env.log(`skip ${v}: ${(e as Error).message}`));
  // Only on request: `docker builder prune` hits every project on the machine, not just ours.
  if (victims.length && o.prune) await env.run("docker", ["builder", "prune", "-f"], { allowFail: true });
  emit(env, { removed: victims }, [victims.length ? `removed: ${victims.join(", ")}` : "nothing to collect"]);
}

export async function cmdDoctor(env: Env, name?: string) {
  const checks: { check: string; ok: boolean; detail: string }[] = [];
  const v = await env.run("ddev", ["version"], { allowFail: true });
  checks.push({ check: "ddev on PATH", ok: v.exitCode === 0, detail: v.stdout.split("\n")[0] ?? "" });
  const mainStatus = await ddevStatus(env.run, env.cfg.main);
  checks.push({ check: `main project "${env.cfg.main}" running`, ok: mainStatus === "running", detail: mainStatus ?? "not found in ddev list" });
  const dns = await env.run("sh", ["-c", `getent hosts wt-probe.${env.cfg.tld} 2>/dev/null || dscacheutil -q host -a name wt-probe.${env.cfg.tld} 2>/dev/null || nslookup wt-probe.${env.cfg.tld} 2>/dev/null | tail -2`], { allowFail: true });
  checks.push({ check: `wildcard DNS *.${env.cfg.tld} → 127.0.0.1`, ok: /127\.0\.0\.1/.test(dns.stdout), detail: /127\.0\.0\.1/.test(dns.stdout) ? "ok" : "not resolving — offline? see ARCHITECTURE.md §7.5" });
  // wt writes `name:` into each worktree's config.wt.local.yaml, so main may pin its own
  // name — what matters is that `.wt.yml: main` agrees with it, or "is main running?" checks
  // a project that does not exist.
  const { readDdevConfig } = await import("../core/ddevconfig.js");
  const ddevCfg = await readDdevConfig(env.repoRoot);
  const nameOk = !ddevCfg.name || ddevCfg.name === env.cfg.main;
  checks.push({ check: "`.wt.yml: main` matches the DDEV project name", ok: nameOk,
    detail: nameOk ? (ddevCfg.name ? `ok (${ddevCfg.name})` : `ok (derived from directory: ${env.cfg.main})`)
                   : `.ddev/config.yaml says "${ddevCfg.name}", .wt.yml says "${env.cfg.main}" — set main: ${ddevCfg.name}` });
  const gi = await env.run("git", ["check-ignore", "-q", ".wt/manifest.json"], { cwd: env.repoRoot, allowFail: true });
  checks.push({ check: ".wt/ is gitignored", ok: gi.exitCode === 0, detail: gi.exitCode === 0 ? "ok" : "add `.wt/` to .gitignore" });

  // Worktrees inside main's approot are inside main's Mutagen sync unless excluded, and a
  // `wt destroy` inside a watched tree can wedge the session so main will not start at all.
  // Only worth checking where Mutagen is actually in play.
  const { effectiveUploadDirs } = await import("../core/ddevconfig.js");
  const { mutagenInPlay, planExclusion, RESET_HINT } = await import("../core/mutagen.js");
  if (mutagenInPlay(env.repoRoot, ddevCfg)) {
    const plan = planExclusion(ddevCfg.docroot, env.cfg.worktrees_dir, await effectiveUploadDirs(env.repoRoot));
    checks.push({ check: `${env.cfg.worktrees_dir} is excluded from main's Mutagen sync`, ok: plan.present,
      detail: plan.present ? `ok (upload_dirs: ${plan.entry})`
        : `add "${plan.entry}" to upload_dirs in .ddev/config.wt.local.yaml (paths there are relative to the docroot), then ${RESET_HINT} — or just re-run \`wt init\`` });
  }

  // A pool entry whose DDEV project has vanished will be handed to the next `wt new --pool`
  // and fail there instead of here, where it can actually be explained.
  const liveNames = new Set((await ddevList(env.run)).map((p) => p.name));
  const phantoms = Object.values(env.manifest.worktrees).filter((r) => r.pool && !liveNames.has(r.name));
  if (Object.values(env.manifest.worktrees).some((r) => r.pool)) {
    checks.push({ check: "warm pool entries have live environments", ok: phantoms.length === 0,
      detail: phantoms.length === 0 ? "ok" : `${phantoms.map((p) => p.name).join(", ")} — no such DDEV project; run: wt pool drain` });
  }

  // `git worktree add` only materialises *tracked* files, so a gitignored config file means
  // every worktree boots without it — and the resulting failure says nothing about why.
  for (const a of env.adapters) {
    for (const f of a.sharedFiles?.() ?? []) {
      if (!existsSync(path.join(env.repoRoot, f))) continue;
      // `git check-ignore` deliberately says nothing about tracked files, so it answers the
      // wrong question. What matters is only whether the file is in the index: that, and
      // nothing else, decides whether `git worktree add` materialises it.
      const tracked = await env.run("git", ["ls-files", "--error-unmatch", f], { cwd: env.repoRoot, allowFail: true });
      checks.push({ check: `${f} reaches new worktrees`, ok: tracked.exitCode === 0,
        detail: tracked.exitCode === 0 ? "ok (tracked)" : `${f} exists but is untracked — git worktrees only carry tracked files, so the site will not boot there` });
    }
    // A media path ignored only as `dir/` does not match the symlink wt puts there from
    // level 2 up: the worktree is born dirty and `git add -A` can commit the symlink.
    for (const m of a.mediaPaths()) {
      const bare = m.replace(/\/$/, "");
      const lines = (existsSync(path.join(env.repoRoot, ".gitignore"))
        ? await readFile(path.join(env.repoRoot, ".gitignore"), "utf8") : "").split("\n").map((l) => l.trim());
      if (!lines.includes(`${bare}/`)) continue;           // no dir-only rule, nothing to warn about
      const ok = lines.includes(bare);
      checks.push({ check: `${bare} is ignored as a symlink too`, ok,
        detail: ok ? "ok" : `.gitignore has "${bare}/" but not "${bare}" — wt symlinks it, and "dir/" never matches a symlink` });
    }
  }
  if (name) {
    const r = getRecord(env, name);
    const { detectAdapters } = await import("../adapters/index.js");
    for (const a of await detectAdapters(env.repoRoot, env.cfg.framework)) {
      const h = await a.healthCheck(ctxFor(env, r));
      checks.push({ check: `${a.id} health (${name})`, ok: h.ok, detail: h.detail });
    }
  }
  const allOk = checks.every((c) => c.ok);
  emit(env, { ok: allOk, checks }, checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.check}${c.detail ? ` — ${c.detail}` : ""}`));
  if (!allOk) process.exitCode = 1;
}

function parseDuration(s: string): number {
  const m = /^(\d+)([hd])$/.exec(s);
  if (!m) throw new WtError(EXIT.GENERIC, `bad duration "${s}" (use 12h, 7d)`);
  return Number(m[1]) * (m[2] === "d" ? 24 : 1);
}
