import type { Adapter, DbChangeProvider, RepoConfig } from "../core/types.js";
import { snapshotDiff } from "./snapshot-diff.js";
import { laravelMigrations } from "./laravel-migrations.js";
import { wpChangeset } from "./wp-changeset.js";

/**
 * Registry of change-tracking providers. Adding Liquibase/Flyway/Atlas means
 * one new file implementing DbChangeProvider and one line here.
 */
export const PROVIDERS: Record<string, DbChangeProvider> = {
  [snapshotDiff.id]: snapshotDiff,
  [laravelMigrations.id]: laravelMigrations,
  [wpChangeset.id]: wpChangeset,
  // liquibase: see docs/ARCHITECTURE.md §7.6 — runs liquibase/liquibase container on the ddev network
};

export function resolveProviders(cfg: RepoConfig, adapters: Adapter[]): DbChangeProvider[] {
  let ids: string[];
  if (cfg.db.change_provider === "auto") ids = [...new Set(adapters.flatMap((a) => a.defaultChangeProviders()))];
  else ids = Array.isArray(cfg.db.change_provider) ? cfg.db.change_provider : [cfg.db.change_provider];
  if (ids.length === 0) ids = ["snapshot-diff"];
  return ids.map((id) => {
    const p = PROVIDERS[id];
    if (!p) throw new Error(`unknown db.change_provider "${id}" (known: ${Object.keys(PROVIDERS).join(", ")})`);
    return p;
  });
}
