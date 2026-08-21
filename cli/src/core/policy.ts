import { currentOwner } from "./config.js";
import { EXIT, WtError, type Level, type RepoConfig, type WorktreeRecord } from "./types.js";

export const EXIT_POLICY = 8;

export function assertCanCreate(cfg: RepoConfig, level: Level, task: string | undefined) {
  if (!cfg.policy.allow_levels.includes(level))
    throw new WtError(EXIT_POLICY, `policy: level ${level} not allowed (allow_levels: ${cfg.policy.allow_levels.join(",")})`, "ask a human to change .wt.yml policy.allow_levels, or pick another --level");
  if (cfg.policy.require_task && !task?.trim())
    throw new WtError(EXIT_POLICY, "policy: --task is required in this repo", 'wt new <branch> --task "what you will do"');
}

export function isOwner(rec: WorktreeRecord) { return rec.owner === currentOwner(); }
export function leaseExpired(rec: WorktreeRecord) { return Date.parse(rec.leaseUntil) < Date.now(); }

export function assertCanDestroy(cfg: RepoConfig, rec: WorktreeRecord, force: boolean) {
  if (force || cfg.policy.allow_destroy === "any" || isOwner(rec) || leaseExpired(rec) || rec.pool) return;
  throw new WtError(EXIT_POLICY, `policy: "${rec.name}" is owned by ${rec.owner} (lease until ${rec.leaseUntil})`, "wait for the lease to expire, ask the owner, or use --force");
}

export function assertCanMutate(cfg: RepoConfig, rec: WorktreeRecord, force: boolean) {
  // promote / db reset / sync use the same rule as destroy
  assertCanDestroy(cfg, rec, force);
}

export function newLease(cfg: RepoConfig) {
  return new Date(Date.now() + cfg.policy.lease_hours * 36e5).toISOString();
}

export { EXIT };
