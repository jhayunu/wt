import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DbChangeProvider } from "../core/types.js";
import { ddev } from "../core/ddev.js";

/**
 * WordPress content changeset via WP-CLI:
 *  - options.json : tracked wp_options (non-transient, non-denied) as JSON
 *  - posts.wxr    : WXR export of posts modified since baseline
 *  - acf/         : ACF local JSON is already file-based; nothing to do
 * Replay: `wp option update` per key, `wp import posts.wxr --authors=skip`.
 */
const DENY_OPTS = /^(_transient_|_site_transient_|cron$|siteurl$|home$|recently_activated$|auth_key|secure_auth|logged_in|nonce)/;

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
    const posts = await ddev.exec(ctx.run, ctx.rec.path, ["wp", "post", "list", "--post_type=any", "--post_status=any", "--format=count", `--post_modified_gmt>=${since}`], );
    const before = JSON.parse(await readFile(path.join(dir, "options.json"), "utf8")) as { option_name: string; option_value: unknown }[];
    const now = JSON.parse((await ddev.exec(ctx.run, ctx.rec.path, ["wp", "option", "list", "--format=json", "--unserialize"])).stdout) as typeof before;
    const bmap = new Map(before.map((o) => [o.option_name, JSON.stringify(o.option_value)]));
    const changed = now.filter((o) => !DENY_OPTS.test(o.option_name) && bmap.get(o.option_name) !== JSON.stringify(o.option_value));
    const n = Number(posts.stdout.trim()) || 0;
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
      const changed = now.filter((o) => !DENY_OPTS.test(o.option_name) && bmap.get(o.option_name) !== JSON.stringify(o.option_value))
        .sort((a, b) => a.option_name.localeCompare(b.option_name));
      const json = JSON.stringify(changed, null, 2).split(ctx.rec.url).join("{{WT_URL}}");
      const p = path.join(dir, "options.json"); await writeFile(p, json + "\n"); written.push(p);
    }
    if (cs.data.wp_posts) {
      const p = path.join(dir, "posts.wxr");
      const r = await ddev.exec(ctx.run, ctx.rec.path, ["wp", "export", "--stdout", `--start_date=${since.slice(0, 10)}`, "--post_type=any"]);
      await writeFile(p, r.stdout.split(ctx.rec.url).join("{{WT_URL}}")); written.push(p);
    }
    return written;
  },

  async apply(ctx, dir) {
    const opts = path.join(dir, "options.json");
    if (existsSync(opts)) {
      const list = JSON.parse((await readFile(opts, "utf8")).split("{{WT_URL}}").join(ctx.rec.url)) as { option_name: string; option_value: unknown }[];
      for (const o of list) {
        await ddev.exec(ctx.run, ctx.rec.path, ["wp", "option", "update", o.option_name, "--format=json", "--", JSON.stringify(o.option_value)]);
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
