import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { EXIT, WtError, type Ctx, type DbChangeProvider, type RepoConfig } from "../core/types.js";
import { ddev } from "../core/ddev.js";
import { isDenied } from "./deny.js";

/**
 * WordPress content changeset via WP-CLI:
 *  - options.json : tracked wp_options (non-transient, non-denied) as JSON
 *  - posts.wxr    : WXR export of posts modified since baseline
 *  - acf/         : ACF local JSON is already file-based; nothing to do
 * Replay: `wp option update` per key, `wp import posts.wxr --authors=skip`.
 */
// URL/session churn that is never a real content change. Secrets and other churn come
// from `db.deny_rows` instead, so one config governs both providers (see providers/deny.ts).
const DENY_OPTS = /^(_transient_|_site_transient_|cron$|siteurl$|home$|recently_activated$|auth_key|secure_auth|logged_in|nonce)/;
const keep = (ctx: { cfg: RepoConfig }, name: string) => !DENY_OPTS.test(name) && !isDenied(ctx.cfg, "wp_options", name);

/** wp-baseline.txt is written by baseline() as `YYYY-MM-DD HH:MM:SS`. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * IDs of posts modified since the baseline.
 *
 * Two things went wrong before. `diff()` passed `--post_modified_gmt>=<ts>` to
 * `wp post list`, which is not a thing WP-CLI understands — the filter was ignored and
 * every post was counted. `export()` used `wp export --start_date=<date>`, which takes a
 * date and not a timestamp, so every post created on the same day as the worktree was in
 * range: on a worktree made today, all of them.
 *
 * The query runs through `wp eval-file -` on stdin: no shell quoting, no assumptions about
 * the table prefix, and WP's own date_query semantics for `post_modified_gmt`.
 */
async function modifiedPostIds(ctx: Ctx, since: string): Promise<number[]> {
  const ts = since.trim();
  if (!TIMESTAMP.test(ts)) throw new WtError(EXIT.GENERIC, `unusable baseline timestamp: "${ts}"`, "recreate the worktree so the baseline is rewritten");
  const php = `<?php
$ids = get_posts([
  'post_type' => 'any', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids',
  'date_query' => [['column' => 'post_modified_gmt', 'after' => '${ts}', 'inclusive' => true]],
]);
echo implode(',', $ids);
`;
  const r = await ctx.run("ddev", ["wp", "eval-file", "-"], { cwd: ctx.rec.path, input: php, allowFail: true });
  if (r.exitCode !== 0) return [];
  return r.stdout.trim().split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

export const wpChangeset: DbChangeProvider = {
  id: "wp-changeset",
  async detect(root) { return existsSync(path.join(root, "wp-content")) || existsSync(path.join(root, "web/wp-content")); },

  async baseline(ctx) {
    const marker = new Date().toISOString().replace("T", " ").slice(0, 19);
    const dir = path.join(ctx.repoRoot, ".wt", "baseline", ctx.rec.name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "wp-baseline.txt"), marker);
    if (!ctx.dryRun) {
      const r = await ddev.exec(ctx.run, ctx.rec.path, ["wp", "option", "list", "--format=json", "--unserialize"]);
      await writeFile(path.join(dir, "options.json"), r.stdout);
    }
    return marker;
  },

  async diff(ctx) {
    const dir = path.join(ctx.repoRoot, ".wt", "baseline", ctx.rec.name);
    const since = await readFile(path.join(dir, "wp-baseline.txt"), "utf8");
    const changedPosts = await modifiedPostIds(ctx, since);
    const before = JSON.parse(await readFile(path.join(dir, "options.json"), "utf8")) as { option_name: string; option_value: unknown }[];
    const now = JSON.parse((await ddev.exec(ctx.run, ctx.rec.path, ["wp", "option", "list", "--format=json", "--unserialize"])).stdout) as typeof before;
    const bmap = new Map(before.map((o) => [o.option_name, JSON.stringify(o.option_value)]));
    const changed = now.filter((o) => keep(ctx, o.option_name) && bmap.get(o.option_name) !== JSON.stringify(o.option_value));
    const n = changedPosts.length;
    const data: Record<string, number> = {};
    if (changed.length) data.wp_options = changed.length;
    if (n) data.wp_posts = n;
    return { provider: "wp-changeset", schema: [], data, empty: !changed.length && !n };
  },

  async export(ctx, cs, dir) {
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    const since = await readFile(path.join(ctx.repoRoot, ".wt", "baseline", ctx.rec.name, "wp-baseline.txt"), "utf8");
    if (cs.data.wp_options) {
      const now = JSON.parse((await ddev.exec(ctx.run, ctx.rec.path, ["wp", "option", "list", "--format=json", "--unserialize"])).stdout) as { option_name: string; option_value: unknown }[];
      const before = JSON.parse(await readFile(path.join(ctx.repoRoot, ".wt", "baseline", ctx.rec.name, "options.json"), "utf8")) as typeof now;
      const bmap = new Map(before.map((o) => [o.option_name, JSON.stringify(o.option_value)]));
      const changed = now.filter((o) => keep(ctx, o.option_name) && bmap.get(o.option_name) !== JSON.stringify(o.option_value))
        .sort((a, b) => a.option_name.localeCompare(b.option_name));
      const json = JSON.stringify(changed, null, 2).split(ctx.rec.url).join("{{WT_URL}}");
      const p = path.join(dir, "options.json"); await writeFile(p, json + "\n"); written.push(p);
    }
    if (cs.data.wp_posts) {
      const ids = await modifiedPostIds(ctx, since);
      if (ids.length) {
        const p = path.join(dir, "posts.wxr");
        const r = await ddev.exec(ctx.run, ctx.rec.path, ["wp", "export", "--stdout", "--post_type=any", `--post__in=${ids.join(",")}`]);
        await writeFile(p, r.stdout.split(ctx.rec.url).join("{{WT_URL}}")); written.push(p);
      }
    }
    return written;
  },

  async apply(ctx, dir) {
    const opts = path.join(dir, "options.json");
    if (existsSync(opts)) {
      const list = JSON.parse((await readFile(opts, "utf8")).split("{{WT_URL}}").join(ctx.rec.url)) as { option_name: string; option_value: unknown }[];
      for (const o of list) {
        // The value goes in on stdin: passing it as an argument means it crosses bash
        // (ddev exec) and then WP-CLI's own parser, which double-quotes it into a second
        // positional argument — "Error: Too many positional arguments".
        await ctx.run("ddev", ["wp", "option", "update", o.option_name, "--format=json"],
          { cwd: ctx.rec.path, input: JSON.stringify(o.option_value) });
      }
    }
    const wxr = path.join(dir, "posts.wxr");
    if (existsSync(wxr)) {
      const rel = path.relative(ctx.rec.path, wxr);
      await ddev.exec(ctx.run, ctx.rec.path, ["wp", "plugin", "install", "wordpress-importer", "--activate"]).catch(() => {});
      await ddev.exec(ctx.run, ctx.rec.path, ["wp", "import", rel, "--authors=skip"]);
    }
  },

  async status() { return { applied: [], pending: [] }; },
};
