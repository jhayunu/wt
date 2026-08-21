import lockfile from "proper-lockfile";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/** Serialises mutating commands (new/destroy/promote) across concurrent agents. */
export async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.join(repoRoot, ".wt");
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "lock");
  if (!existsSync(target)) await writeFile(target, "");
  const release = await lockfile.lock(target, { retries: { retries: 30, minTimeout: 500, maxTimeout: 2000 }, stale: 120_000 });
  try { return await fn(); } finally { await release(); }
}
