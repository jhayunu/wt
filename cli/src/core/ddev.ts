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
  // `ddev snapshot restore` has no -y/--yes flag (verified against DDEV v1.25.1) — passing one aborts the command.
  snapshotRestore: (run: Runner, cwd: string, name: string) => run("ddev", ["snapshot", "restore", name], { cwd }),
  exportDb: (run: Runner, cwd: string, file: string) => run("ddev", ["export-db", "--file", file, "--gzip=false"], { cwd }),
  importDb: (run: Runner, cwd: string, file: string) => run("ddev", ["import-db", "--file", file], { cwd }),
  /**
   * Run SQL against the project database via stdin.
   *
   * Deliberately not `ddev exec mysql db -e "<sql>"`: `ddev exec` runs its argument
   * through bash, and mysqldump always backtick-quotes identifiers, so bash turns
   * `\`wp_options\`` into command substitution before MySQL sees it. stdin has no
   * such layer. `ddev mysql` already targets the project database.
   */
  mysqlIn: (run: Runner, cwd: string, sql: string) => run("ddev", ["mysql"], { cwd, input: sql }),
};
