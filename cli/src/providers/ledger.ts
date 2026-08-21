import type { Ctx } from "../core/types.js";
import { ddev } from "../core/ddev.js";

/**
 * Applied-changeset ledger: a tiny table in the worktree's own DB recording which
 * db/changes/<dir> entries have been replayed. Makes `wt db apply` idempotent and
 * `wt db status` truthful. Same idea as Liquibase's DATABASECHANGELOG, deliberately minimal.
 */
export const LEDGER_TABLE = "wt_changesets";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export async function ensureLedger(ctx: Ctx) {
  await ddev.exec(ctx.run, ctx.rec.path, ["mysql", "db", "-e",
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (id INT AUTO_INCREMENT PRIMARY KEY, changeset VARCHAR(255) NOT NULL, provider VARCHAR(64) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, applied_by VARCHAR(128), UNIQUE KEY uq (changeset, provider))`]);
}

export async function listApplied(ctx: Ctx): Promise<Set<string>> {
  const r = await ddev.exec(ctx.run, ctx.rec.path, ["mysql", "db", "-N", "-e", `SELECT CONCAT(changeset,'/',provider) FROM ${LEDGER_TABLE}`]).catch(() => ({ stdout: "" }));
  return new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
}

export async function markApplied(ctx: Ctx, changeset: string, provider: string) {
  await ddev.exec(ctx.run, ctx.rec.path, ["mysql", "db", "-e",
    `INSERT IGNORE INTO ${LEDGER_TABLE} (changeset, provider, applied_by) VALUES ('${esc(changeset)}','${esc(provider)}','${esc(ctx.rec.owner)}')`]);
}
