import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export interface DdevProjectConfig { name?: string; tld?: string }

/**
 * The bits of the canonical checkout's .ddev/config.yaml that wt needs.
 *
 * `name` matters because a repo that pins its DDEV project name (most do) would
 * otherwise disagree with `.wt.yml: main`, and every "is main running?" check
 * would look up a project that does not exist.
 */
export async function readDdevConfig(repoRoot: string): Promise<DdevProjectConfig> {
  const f = path.join(repoRoot, ".ddev", "config.yaml");
  if (!existsSync(f)) return {};
  try {
    const y = (YAML.parse(await readFile(f, "utf8")) ?? {}) as Record<string, unknown>;
    return {
      name: typeof y.name === "string" && y.name.trim() ? y.name.trim() : undefined,
      tld: typeof y.project_tld === "string" && y.project_tld.trim() ? y.project_tld.trim() : undefined,
    };
  } catch { return {}; }
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
