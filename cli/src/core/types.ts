export type Level = 0 | 1 | 2 | 3 | 4;
export const LEVEL_NAMES: Record<Level, string> = { 0: "none", 1: "shared", 2: "app", 3: "full", 4: "clean" };

export type Framework = "wordpress" | "laravel" | "react" | "drupal" | "composite" | "unknown";
export type DbStrategy = "snapshot" | "dump" | "seedfile" | "fresh" | "none";
export type MediaStrategy = "symlink" | "copy" | "proxy" | "none";

/** Repo-level policy, committed as .wt.yml */
export interface RepoConfig {
  main: string;                 // DDEV project name of canonical checkout
  framework: Framework | "auto";
  min_level: Level;
  max_level: Level;
  max_concurrent: number;
  worktrees_dir: string;        // relative to repo root
  tld: string;
  defaults: { db: DbStrategy; media: MediaStrategy };
  hints: Record<string, Level>;
  db: {
    change_provider: "auto" | string | string[];
    changes_dir: string;
    track_tables: string[];
    deny_tables: string[];
    deny_rows: Record<string, string[]>;
  };
  laravel: { auto_migrate: boolean; queue: "per-project" | "shared-prefixed" | "none" };
  wordpress: { search_replace_extra: string[]; exclude_tables: string[] };
  react: { pair_with?: string; port_range: [number, number] };
  policy: {
    allow_destroy: "own" | "any";
    allow_levels: Level[];
    require_task: boolean;
    lease_hours: number;          // after this, anyone may destroy without --force
  };
  pool: { size: number; level: Level; prefix: string };
  seed: { file: string; refresh: "ddev-pull" | "export-main" | "none"; pull_env: string };
}

/** One worktree + environment, persisted in .wt/manifest.json */
export interface WorktreeRecord {
  name: string;                 // DDEV project name / directory name (slug)
  branch: string;
  path: string;                 // absolute
  level: Level;
  framework: Framework;
  db: DbStrategy;
  media: MediaStrategy;
  url: string;
  createdAt: string;
  owner: string;                // who created it (WT_OWNER | CLAUDE_SESSION_ID | user@host)
  leaseUntil: string;           // ISO; destroy by others needs --force until then
  pool?: boolean;               // true while sitting in the warm pool
  prevUrl?: string;             // URL the DB currently references (pool claim / rename)
  task?: string;
  createdFiles: string[];       // absolute paths wt generated; removed on destroy
  snapshots: string[];
  baseline?: string;            // DbChangeProvider baseline marker
}

export interface Manifest {
  version: 1;
  worktrees: Record<string, WorktreeRecord>;
}

/** Everything a step/adapter needs to do its work. */
export interface Ctx {
  repoRoot: string;             // main checkout root
  cfg: RepoConfig;
  rec: WorktreeRecord;
  dryRun: boolean;
  json: boolean;
  log: (msg: string) => void;
  run: Runner;
}

export interface RunResult { stdout: string; stderr: string; exitCode: number }
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; input?: string; allowFail?: boolean }) => Promise<RunResult>;

/** A reversible unit of work. `down` is only called on rollback. */
export interface Step {
  title: string;
  up: (ctx: Ctx) => Promise<void>;
  down?: (ctx: Ctx) => Promise<void>;
  /** optional steps warn and continue on failure instead of rolling back the whole plan (e.g. media sync, cache warmers) */
  optional?: boolean;
}

export interface Adapter {
  id: Framework;
  detect(repoRoot: string): Promise<boolean>;
  floorLevel(): Level;
  /** YAML object merged into .ddev/config.wt.local.yaml */
  ddevOverrides(ctx: Ctx): Record<string, unknown>;
  mediaPaths(): string[];
  /** Directories the framework needs that git does not carry (gitignored, so `git worktree add` omits them). */
  requiredDirs?(): string[];
  /** Files copied verbatim from main into a level 0/1 worktree, which gets no generated env files. */
  sharedFiles?(): string[];
  /** A tracked file at the tree's root, used to tell when a worktree has finished syncing into the container. */
  treeMarker?(): string;
  /** Dependency trees git does not carry — marker path plus the command that creates it. */
  dependencies?(): { marker: string; tool: string; args: string[] }[];
  envFiles(ctx: Ctx): Promise<Record<string, string>>;   // relPath -> content
  postStart(ctx: Ctx): Promise<void>;
  healthCheck(ctx: Ctx): Promise<{ ok: boolean; detail: string }>;
  defaultChangeProviders(): string[];
}

export interface ChangeSet {
  provider: string;
  schema: string[];             // human-readable lines
  data: Record<string, number>; // table -> changed rows
  empty: boolean;
}

export interface DbChangeProvider {
  id: string;
  detect(repoRoot: string): Promise<boolean>;
  baseline(ctx: Ctx): Promise<string>;               // returns marker (e.g. snapshot name / dump path)
  diff(ctx: Ctx): Promise<ChangeSet>;
  export(ctx: Ctx, cs: ChangeSet, dir: string): Promise<string[]>;
  apply(ctx: Ctx, dir: string): Promise<void>;
  status(ctx: Ctx): Promise<{ applied: string[]; pending: string[] }>;
}

export class WtError extends Error {
  constructor(public code: number, message: string, public hint?: string) { super(message); }
}
export const EXIT = {
  GENERIC: 1, NAME_CLASH: 2, MAIN_NOT_RUNNING: 3, LIMIT: 4, NOT_FOUND: 5, DDEV_MISSING: 6, DIRTY: 7,
} as const;
