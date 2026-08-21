import lockfile from "proper-lockfile";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Locks held by *this* process, so the lock can be re-entered.
 *
 * Commands compose — `wt finish` merges and then calls `cmdDestroy`, which locks too —
 * and without re-entrancy the inner call waits on a lock its own caller is holding until
 * the retries run out. That deadlock is worse than no lock at all: it strands the command
 * halfway, having done the irreversible half (the merge) but not the cleanup.
 *
 * Cross-process exclusion is unchanged: only the outermost frame takes and releases the
 * real lockfile.
 */
const held = new Map<string, { release: () => Promise<void>; depth: number }>();

/** Serialises mutating commands (new/destroy/promote/finish) across concurrent agents. */
export async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot);
  const existing = held.get(key);
  if (existing) {
    existing.depth++;
    try { return await fn(); } finally { existing.depth--; }
  }

  const dir = path.join(repoRoot, ".wt");
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "lock");
  if (!existsSync(target)) await writeFile(target, "");
  const release = await lockfile.lock(target, { retries: { retries: 30, minTimeout: 500, maxTimeout: 2000 }, stale: 120_000 });
  const entry = { release, depth: 1 };
  held.set(key, entry);
  try {
    return await fn();
  } finally {
    entry.depth--;
    if (entry.depth === 0) { held.delete(key); await release(); }
  }
}
