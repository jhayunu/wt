import type { Runner } from "./types.js";

export interface DdevProject { name: string; status: string; approot: string; primary_url?: string; type?: string }

export async function ddevAvailable(run: Runner) {
  const r = await run("ddev", ["version"], { allowFail: true });
  return r.exitCode === 0;
}

export async function ddevList(run: Runner): Promise<DdevProject[]> {
  const r = await run("ddev", ["list", "--json-output"], { allowFail: true });
  if (r.exitCode !== 0 || !r.stdout.trim()) return [];
  try {
    const j = JSON.parse(r.stdout);
    return (j.raw ?? []) as DdevProject[];
  } catch { return []; }
}

export async function ddevStatus(run: Runner, name: string): Promise<string | undefined> {
  return (await ddevList(run)).find((p) => p.name === name)?.status;
}

export const ddev = {
  start: (run: Runner, cwd: string) => run("ddev", ["start", "-y"], { cwd }),
  stop: (run: Runner, name: string) => run("ddev", ["stop", name], { allowFail: true }),
  delete: (run: Runner, name: string) => run("ddev", ["delete", "-Oy", name], { allowFail: true }),
  exec: (run: Runner, cwd: string, args: string[]) => run("ddev", ["exec", ...args], { cwd }),
  snapshot: (run: Runner, cwd: string, name: string) => run("ddev", ["snapshot", "--name", name, "-y"], { cwd }),
  snapshotRestore: (run: Runner, cwd: string, name: string) => run("ddev", ["snapshot", "restore", name, "-y"], { cwd }),
  exportDb: (run: Runner, cwd: string, file: string) => run("ddev", ["export-db", "--file", file, "--gzip=false"], { cwd }),
  importDb: (run: Runner, cwd: string, file: string) => run("ddev", ["import-db", "--file", file], { cwd }),
};
