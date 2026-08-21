import { existsSync } from "node:fs";
import path from "node:path";
import type { DbChangeProvider } from "../core/types.js";
import { ddev } from "../core/ddev.js";

/** Migrations *are* the changeset; this provider just reports and warns on drift. */
export const laravelMigrations: DbChangeProvider = {
  id: "laravel-migrations",
  async detect(root) { return existsSync(path.join(root, "artisan")); },
  async baseline(ctx) {
    if (ctx.dryRun) return "migrate:status";
    const r = await ddev.exec(ctx.run, ctx.rec.path, ["php", "artisan", "migrate:status", "--no-ansi"]);
    return r.stdout;
  },
  async diff(ctx) {
    const r = await ddev.exec(ctx.run, ctx.rec.path, ["php", "artisan", "migrate:status", "--no-ansi"], );
    const pending = r.stdout.split("\n").filter((l) => /Pending/i.test(l)).map((l) => l.trim());
    return { provider: "laravel-migrations", schema: pending.map((p) => `pending: ${p}`), data: {}, empty: pending.length === 0 };
  },
  async export() { return []; },
  async apply(ctx) { await ddev.exec(ctx.run, ctx.rec.path, ["php", "artisan", "migrate", "--force"]); },
  async status(ctx) {
    const r = await ddev.exec(ctx.run, ctx.rec.path, ["php", "artisan", "migrate:status", "--no-ansi"]);
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter((l) => /\d{4}_\d{2}_\d{2}/.test(l));
    return { applied: lines.filter((l) => /Ran/i.test(l)), pending: lines.filter((l) => /Pending/i.test(l)) };
  },
};
