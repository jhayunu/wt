import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Adapter } from "../core/types.js";
import { ddev } from "../core/ddev.js";

export const laravel: Adapter = {
  id: "laravel",
  floorLevel: () => 1, // escalated to 2 by migration hints / paths
  async detect(root) { return existsSync(path.join(root, "artisan")); },
  mediaPaths: () => ["storage/app/public"],
  // `bootstrap/cache` is gitignored in most Laravel repos, so a fresh worktree lacks it
  // and every artisan call dies with "directory must be present and writable".
  requiredDirs: () => ["bootstrap/cache", "storage/framework/cache/data", "storage/framework/sessions", "storage/framework/views", "storage/logs"],
  // Level 0/1 shares main's database and URL, so it wants main's .env verbatim. Without
  // one, Laravel falls back to APP_ENV=production and boots into production guards.
  sharedFiles: () => [".env"],
  treeMarker: () => "artisan",
  dependencies: () => [{ marker: "vendor/autoload.php", tool: "composer", args: ["install", "--no-scripts", "--no-interaction"] }],
  defaultChangeProviders: () => ["laravel-migrations", "snapshot-diff"],

  ddevOverrides(ctx) {
    const post: { exec: string }[] = [{ exec: "php artisan storage:link || true" }, { exec: "php artisan optimize:clear || true" }];
    if (ctx.rec.level >= 2 && ctx.cfg.laravel.auto_migrate) post.unshift({ exec: "php artisan migrate --force" });
    const o: Record<string, unknown> = {
      type: "laravel",
      upload_dirs: ["storage/app/public"],
      hooks: { "post-start": post },
    };
    if (ctx.rec.level >= 2 && ctx.cfg.laravel.queue === "per-project") {
      o.web_extra_daemons = [{ name: "queue", command: "php artisan queue:work --tries=3 --sleep=3", directory: "/var/www/html" }];
    }
    return o;
  },

  async envFiles(ctx) {
    const src = path.join(ctx.repoRoot, ".env");
    const base = existsSync(src) ? await readFile(src, "utf8") : "";
    const set: Record<string, string> = {
      APP_ENV: "local",
      APP_URL: ctx.rec.url,
      ASSET_URL: ctx.rec.url,
      DB_CONNECTION: "mysql", DB_HOST: "db", DB_PORT: "3306", DB_DATABASE: "db", DB_USERNAME: "db", DB_PASSWORD: "db",
      CACHE_PREFIX: ctx.rec.name, REDIS_PREFIX: `${ctx.rec.name}:`,
      MAIL_MAILER: "smtp", MAIL_HOST: "localhost", MAIL_PORT: "1025",
      QUEUE_CONNECTION: ctx.cfg.laravel.queue === "none" ? "sync" : "database",
    };
    const lines = base.split("\n").filter((l) => !Object.keys(set).some((k) => l.startsWith(`${k}=`)));
    lines.push(`# --- wt overrides (worktree: ${ctx.rec.name}) ---`, ...Object.entries(set).map(([k, v]) => `${k}=${v}`));
    return { ".env": lines.join("\n") + "\n" };
  },

  async postStart(ctx) {
    if (ctx.rec.level >= 2) await ddev.snapshot(ctx.run, ctx.rec.path, "wt-pre-task");
  },

  async healthCheck(ctx) {
    const r = await ctx.run("curl", ["-ksfo", "/dev/null", "-w", "%{http_code}", ctx.rec.url], { allowFail: true });
    return { ok: /^[23]/.test(r.stdout.trim()), detail: `HTTP ${r.stdout.trim() || "n/a"} ${ctx.rec.url}` };
  },
};
