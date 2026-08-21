import { execa } from "execa";
import type { Runner } from "./types.js";

/** Real runner. */
export const realRunner: Runner = async (cmd, args, opts = {}) => {
  const r = await execa(cmd, args, { cwd: opts.cwd, input: opts.input, reject: false, all: false });
  if (r.exitCode !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.exitCode}): ${r.stderr || r.stdout}`);
  }
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
};

/** Dry-run runner: prints instead of executing; read-only git/ddev queries still execute. */
export function dryRunner(log: (s: string) => void): Runner {
  const readOnly = new Set(["git rev-parse", "git worktree list", "git branch", "git status", "ddev list", "ddev describe", "ddev version", "which"]);
  return async (cmd, args, opts = {}) => {
    const sig = `${cmd} ${args.slice(0, 2).join(" ")}`;
    if ([...readOnly].some((k) => sig.startsWith(k))) return realRunner(cmd, args, { ...opts, allowFail: true });
    log(`$ ${[cmd, ...args].join(" ")}${opts.cwd ? `   (cwd: ${opts.cwd})` : ""}`);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}
