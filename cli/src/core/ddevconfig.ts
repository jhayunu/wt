import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export interface DdevProjectConfig {
  name?: string;
  tld?: string;
  /** `docroot:` — upload_dirs are resolved relative to *this*, not to the approot. */
  docroot?: string;
  /** `upload_dirs:`, verbatim. Absent and empty are different: empty means "explicitly none". */
  uploadDirs?: string[];
  performanceMode?: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * The bits of the canonical checkout's .ddev/config.yaml that wt needs.
 *
 * `name` matters because a repo that pins its DDEV project name (most do) would
 * otherwise disagree with `.wt.yml: main`, and every "is main running?" check
 * would look up a project that does not exist.
 *
 * Reads the committed config only. `upload_dirs` may also come from a
 * `config.*.yaml` override — `effectiveUploadDirs` handles that.
 */
export async function readDdevConfig(repoRoot: string): Promise<DdevProjectConfig> {
  const f = path.join(repoRoot, ".ddev", "config.yaml");
  if (!existsSync(f)) return {};
  try {
    const y = (YAML.parse(await readFile(f, "utf8")) ?? {}) as Record<string, unknown>;
    return {
      name: str(y.name),
      tld: str(y.project_tld),
      docroot: typeof y.docroot === "string" ? y.docroot.trim() : undefined,
      uploadDirs: Array.isArray(y.upload_dirs) ? y.upload_dirs.filter((d): d is string => typeof d === "string") : undefined,
      performanceMode: str(y.performance_mode),
    };
  } catch { return {}; }
}

/**
 * `upload_dirs` as DDEV will see them: `config.wt.local.yaml` is merged on top of
 * `config.yaml`, and for a list that means replacement, not append. Reading both is the
 * only way to add an entry without silently dropping one the project already had.
 */
export async function effectiveUploadDirs(repoRoot: string): Promise<string[] | undefined> {
  for (const f of ["config.wt.local.yaml", "config.yaml"]) {
    const p = path.join(repoRoot, ".ddev", f);
    if (!existsSync(p)) continue;
    try {
      const y = (YAML.parse(await readFile(p, "utf8")) ?? {}) as Record<string, unknown>;
      if (Array.isArray(y.upload_dirs)) return y.upload_dirs.filter((d): d is string => typeof d === "string");
    } catch { /* unparseable — fall through to the next file */ }
  }
  return undefined;
}

/**
 * URL of a sibling project: main's primary URL with its first hostname label
 * swapped for `name`. That carries over a custom `project_tld` and any
 * non-default router port (`https://main.ddev.site:444`), which a hand-built
 * `https://<name>.<tld>` silently gets wrong.
 */
export function urlFor(name: string, tld: string, mainPrimaryUrl?: string): string {
  if (mainPrimaryUrl) {
    try {
      const u = new URL(mainPrimaryUrl);
      const labels = u.hostname.split(".");
      labels[0] = name;
      u.hostname = labels.join(".");
      return u.origin;
    } catch { /* malformed — fall back to the plain form */ }
  }
  return `https://${name}.${tld}`;
}
