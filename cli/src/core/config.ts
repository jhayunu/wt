import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Level, Manifest, RepoConfig } from "./types.js";

const level = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const RepoConfigSchema = z.object({
  main: z.string().min(1),
  framework: z.enum(["auto", "wordpress", "laravel", "react", "drupal", "composite", "unknown"]).default("auto"),
  min_level: level.default(0),
  max_level: level.default(4),
  max_concurrent: z.number().int().positive().default(4),
  worktrees_dir: z.string().default(".wt/worktrees"),
  tld: z.string().default("ddev.site"),
  defaults: z.object({
    db: z.enum(["snapshot", "dump", "seedfile", "fresh", "none"]).default("snapshot"),
    media: z.enum(["symlink", "copy", "proxy", "none"]).default("symlink"),
  }).default({}),
  hints: z.record(level).default({
    "migration|schema|seeder": 2,
    "import|media|thumbnail|upload|resize": 3,
  }),
  db: z.object({
    change_provider: z.union([z.string(), z.array(z.string())]).default("auto"),
    changes_dir: z.string().default("db/changes"),
    track_tables: z.array(z.string()).default([]),
    deny_tables: z.array(z.string()).default(["wp_users", "wp_usermeta", "sessions", "personal_access_tokens"]),
  }).default({}),
  laravel: z.object({
    auto_migrate: z.boolean().default(true),
    queue: z.enum(["per-project", "shared-prefixed", "none"]).default("per-project"),
  }).default({}),
  wordpress: z.object({
    search_replace_extra: z.array(z.string()).default([]),
    exclude_tables: z.array(z.string()).default([]),
  }).default({}),
  react: z.object({
    pair_with: z.string().optional(),
    port_range: z.tuple([z.number(), z.number()]).default([5180, 5280]),
  }).default({}),
  policy: z.object({
    allow_destroy: z.enum(["own", "any"]).default("own"),
    allow_levels: z.array(level).default([0, 1, 2, 3, 4]),
    require_task: z.boolean().default(false),
    lease_hours: z.number().positive().default(24),
  }).default({}),
  seed: z.object({
    file: z.string().default("db/seed.sql.gz"),          // relative to repo root; gitignored
    refresh: z.enum(["ddev-pull", "export-main", "none"]).default("export-main"),
    pull_env: z.string().default("prod"),                // `ddev pull <env>` provider name
  }).default({}),
  pool: z.object({
    size: z.number().int().min(0).default(0),
    level: level.default(2),
    prefix: z.string().default("pool"),
  }).default({}),
});

import os from "node:os";
/** Identity used for ownership. Agents/hosts can set WT_OWNER; Claude Code sets CLAUDE_SESSION_ID. */
export function currentOwner(): string {
  return process.env.WT_OWNER || (process.env.CLAUDE_SESSION_ID ? `claude:${process.env.CLAUDE_SESSION_ID.slice(0, 8)}` : `${os.userInfo().username}@${os.hostname()}`);
}

export const CONFIG_FILE = ".wt.yml";

export async function loadRepoConfig(repoRoot: string): Promise<RepoConfig> {
  const file = path.join(repoRoot, CONFIG_FILE);
  let raw: unknown = {};
  if (existsSync(file)) raw = YAML.parse(await readFile(file, "utf8")) ?? {};
  // `main` defaults to the repo directory name (same rule DDEV uses when name is omitted)
  const withDefault = { main: path.basename(repoRoot), ...(raw as object) };
  return RepoConfigSchema.parse(withDefault) as RepoConfig;
}

export function manifestPath(repoRoot: string) { return path.join(repoRoot, ".wt", "manifest.json"); }

export async function loadManifest(repoRoot: string): Promise<Manifest> {
  const p = manifestPath(repoRoot);
  if (!existsSync(p)) return { version: 1, worktrees: {} };
  return JSON.parse(await readFile(p, "utf8")) as Manifest;
}

export async function saveManifest(repoRoot: string, m: Manifest) {
  await mkdir(path.dirname(manifestPath(repoRoot)), { recursive: true });
  await writeFile(manifestPath(repoRoot), JSON.stringify(m, null, 2) + "\n");
}

export function clampLevel(l: number, cfg: RepoConfig): Level {
  return Math.max(cfg.min_level, Math.min(cfg.max_level, l)) as Level;
}
