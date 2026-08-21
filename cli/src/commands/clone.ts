import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { realRunner } from "../core/proc.js";
import { ddev } from "../core/ddev.js";
import { EXIT, WtError } from "../core/types.js";

/**
 * `wt clone <git-url> [dir]` — one-step onboarding: clone, run the equivalent of `wt init`,
 * start DDEV, optionally pull a seed DB. Mirrors workspace-manager's `init` but keeps the
 * "main checkout + nested worktrees" layout (a bare-clone layout is a phase-3 option).
 */
export async function cmdClone(url: string, dirArg: string | undefined, o: { noStart?: boolean; seed?: boolean; json?: boolean }) {
  const dir = path.resolve(dirArg ?? path.basename(url.replace(/\.git$/, "")));
  if (existsSync(dir)) throw new WtError(EXIT.NAME_CLASH, `directory exists: ${dir}`);
  const log = (s: string) => { if (!o.json) process.stderr.write(pc.dim(s) + "\n"); };
  const run = realRunner;
  try {
    log(`→ git clone ${url}`);
    await run("git", ["clone", url, dir]);
    // reuse `wt init` logic by re-entering the CLI with cwd = dir
    log("→ wt init");
    const me = process.argv[1];
    const init = await run(process.execPath, [me, "init", ...(o.json ? ["--json"] : [])], { cwd: dir, allowFail: true });
    process.stdout.write(init.stdout);
    if (!existsSync(path.join(dir, ".ddev", "config.yaml"))) {
      log("no .ddev/config.yaml in repo — run `ddev config` in the checkout, then `ddev start`");
    } else if (!o.noStart) {
      log("→ ddev start");
      await ddev.start(run, dir);
      if (o.seed) {
        log("→ wt db seed");
        const seed = await run(process.execPath, [me, "db", "seed"], { cwd: dir, allowFail: true });
        process.stdout.write(seed.stdout);
      }
    }
    const msg = `cloned to ${dir}. next: cd ${dir} && wt new <branch> --task "…"`;
    if (o.json) process.stdout.write(JSON.stringify({ ok: true, dir, next: msg }) + "\n"); else process.stdout.write(msg + "\n");
  } catch (e) {
    log(`✗ ${(e as Error).message} — removing ${dir}`);
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}
