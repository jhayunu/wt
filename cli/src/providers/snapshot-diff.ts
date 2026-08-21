import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ChangeSet, Ctx, DbChangeProvider } from "../core/types.js";
import { ddev } from "../core/ddev.js";
import { ddlDiff } from "./ddl-diff.js";
import { denyFor, denyWhere } from "./deny.js";

/**
 * Tool-agnostic provider. Baseline = schema dump + row dumps of tracked tables
 * stored under .wt/baseline/<name>/. diff = dump again and compare. export =
 * write schema.sql (DDL statements that differ) and data/<table>.sql (upserts).
 *
 * Deliberately simple and dependency-free; teams wanting Liquibase/Atlas plug
 * a different provider and get the same CLI.
 */
const baselineDir = (ctx: Ctx) => path.join(ctx.repoRoot, ".wt", "baseline", ctx.rec.name);

async function dumpSchema(ctx: Ctx): Promise<string> {
  const r = await ddev.exec(ctx.run, ctx.rec.path, ["mysqldump", "--no-data", "--skip-comments", "--skip-triggers", "--compact", "db"]);
  // strip AUTO_INCREMENT counters so they don't show as noise
  return r.stdout.replace(/ AUTO_INCREMENT=\d+/g, "");
}

async function dumpTable(ctx: Ctx, table: string): Promise<string> {
  // Denied rows are filtered in the dump itself, so they never reach the baseline on
  // disk either — not just the exported changeset.
  const where = denyWhere(denyFor(ctx.cfg, table));
  const r = await ddev.exec(ctx.run, ctx.rec.path, [
    "mysqldump", "--no-create-info", "--skip-comments", "--skip-triggers", "--compact",
    "--skip-extended-insert", "--replace", "--complete-insert",
    ...(where ? [`--where=${where}`] : []), "db", table,
  ]);
  return tokenise(ctx, r.stdout);
}

/**
 * Rows that are new or changed since the baseline, and rows that disappeared.
 *
 * Pure so it can be unit-tested without a database. `upserts` are whole REPLACE
 * statements straight from mysqldump, which is what makes them replayable as-is.
 */
export function statementDelta(before: string[], after: string[]): { upserts: string[]; removed: string[] } {
  const b = new Set(before), a = new Set(after);
  return { upserts: after.filter((s) => !b.has(s)), removed: before.filter((s) => !a.has(s)) };
}

/** Statements that are pure mysqldump preamble/footer rather than row data. */
const isRowStatement = (s: string) => /^\s*REPLACE\s+INTO/i.test(s);

async function deltaFor(ctx: Ctx, dir: string, table: string) {
  const bFile = path.join(dir, "data", `${table}.sql`);
  // a table added to track_tables after this worktree was created has no baseline file:
  // treat it as "was empty", not as a crash
  const before = splitStatements(existsSync(bFile) ? await readFile(bFile, "utf8") : "").filter(isRowStatement);
  const after = splitStatements(await dumpTable(ctx, table)).filter(isRowStatement);
  return statementDelta(before, after);
}

function tokenise(ctx: Ctx, sql: string) {
  return sql.split(ctx.rec.url).join("{{WT_URL}}").split(`https://${ctx.cfg.main}.${ctx.cfg.tld}`).join("{{WT_URL}}");
}
function detokenise(ctx: Ctx, sql: string) { return sql.split("{{WT_URL}}").join(ctx.rec.url); }

function splitStatements(sql: string): string[] {
  return sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

export const snapshotDiff: DbChangeProvider = {
  id: "snapshot-diff",
  async detect() { return true; },

  async baseline(ctx) {
    const dir = baselineDir(ctx);
    await mkdir(path.join(dir, "data"), { recursive: true });
    if (ctx.dryRun) return dir;
    await writeFile(path.join(dir, "schema.sql"), await dumpSchema(ctx));
    for (const t of ctx.cfg.db.track_tables) await writeFile(path.join(dir, "data", `${t}.sql`), await dumpTable(ctx, t));
    await writeFile(path.join(dir, "meta.json"), JSON.stringify({ v: 2, deny_rows: ctx.cfg.db.deny_rows }, null, 2) + "\n");
    return dir;
  },

  async diff(ctx) {
    const dir = baselineDir(ctx);
    const cs: ChangeSet = { provider: "snapshot-diff", schema: [], data: {}, empty: true };
    if (!existsSync(dir)) throw new Error("no baseline — was this worktree created with wt?");
    const before = await readFile(path.join(dir, "schema.sql"), "utf8");
    const after = await dumpSchema(ctx);
    cs.schema = ddlDiff(before, after);
    if (!existsSync(path.join(dir, "meta.json"))) {
      ctx.log("warning: this baseline predates row-level deny lists; denied rows may show as changes — recreate the worktree to clear it");
    }
    for (const t of ctx.cfg.db.track_tables) {
      if (ctx.cfg.db.deny_tables.includes(t)) continue;
      const { upserts, removed } = await deltaFor(ctx, dir, t);
      const n = upserts.length + removed.length;
      if (n) cs.data[t] = n;
    }
    cs.empty = cs.schema.length === 0 && Object.keys(cs.data).length === 0;
    return cs;
  },

  async export(ctx, cs, dir) {
    const written: string[] = [];
    await mkdir(path.join(dir, "data"), { recursive: true });
    if (cs.schema.length) {
      // Forward ALTERs (baseline → now), plus the full target schema for reference.
      const p = path.join(dir, "schema.sql");
      await writeFile(p, `-- generated by wt snapshot-diff: ${ctx.rec.name} (${ctx.rec.branch})\n` + cs.schema.join("\n\n") + "\n"); written.push(p);
      const full = path.join(dir, "schema.full.sql");
      await writeFile(full, await dumpSchema(ctx)); written.push(full);
    }
    const baseDir = baselineDir(ctx);
    for (const t of Object.keys(cs.data)) {
      const { upserts, removed } = await deltaFor(ctx, baseDir, t);
      if (!upserts.length && !removed.length) continue;
      const head = [`-- generated by wt snapshot-diff: ${ctx.rec.name} (${ctx.rec.branch})`,
        `-- ${upserts.length} row(s) added or changed since the baseline`];
      // Deletions cannot be expressed as REPLACE and turning them into DELETEs needs the
      // primary key, which this provider deliberately does not introspect. Say so in the
      // file rather than letting a reviewer assume the changeset is complete.
      if (removed.length) head.push(`-- NOTE: ${removed.length} row(s) present at baseline are gone now; deletions are NOT exported`);
      const p = path.join(dir, "data", `${t}.sql`);
      await writeFile(p, head.join("\n") + "\n" + (upserts.length ? upserts.join(";\n") + ";\n" : "")); written.push(p);
    }
    const meta = path.join(dir, "changeset.json");
    await writeFile(meta, JSON.stringify({ provider: cs.provider, worktree: ctx.rec.name, branch: ctx.rec.branch, at: new Date().toISOString(), tables: cs.data, schemaChanges: cs.schema.length }, null, 2) + "\n");
    written.push(meta);
    return written;
  },

  async apply(ctx, dir) {
    const schema = path.join(dir, "schema.sql");
    if (existsSync(schema)) {
      const sql = (await readFile(schema, "utf8")).split("\n").filter((l) => !l.startsWith("--")).join("\n");
      if (sql.trim()) await ddev.mysqlIn(ctx.run, ctx.rec.path, sql);
    }
    const dataDir = path.join(dir, "data");
    if (existsSync(dataDir)) {
      for (const f of (await readdir(dataDir)).sort()) {
        const sql = detokenise(ctx, await readFile(path.join(dataDir, f), "utf8"));
        if (sql.trim()) await ddev.mysqlIn(ctx.run, ctx.rec.path, sql);
      }
    }
  },

  async status(ctx) {
    const root = path.join(ctx.rec.path, ctx.cfg.db.changes_dir);
    const all = existsSync(root) ? (await readdir(root)).filter((d) => !d.startsWith(".")).sort() : [];
    const { listApplied } = await import("./ledger.js");
    const done = await listApplied(ctx);
    return { applied: all.filter((d) => done.has(`${d}/snapshot-diff`)), pending: all.filter((d) => !done.has(`${d}/snapshot-diff`)) };
  },
};
