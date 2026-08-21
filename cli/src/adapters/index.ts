import type { Adapter, Framework } from "../core/types.js";
import { wordpress } from "./wordpress.js";
import { laravel } from "./laravel.js";
import { react } from "./react.js";
import { drupal } from "./drupal.js";

export const ADAPTERS: Adapter[] = [wordpress, drupal, laravel, react];

/** Detect all matching adapters; Laravel+React in one repo → composite (both run). */
export async function detectAdapters(root: string, forced: Framework | "auto"): Promise<Adapter[]> {
  if (forced !== "auto" && forced !== "composite" && forced !== "unknown") {
    const a = ADAPTERS.find((x) => x.id === forced);
    return a ? [a] : [];
  }
  const hits: Adapter[] = [];
  for (const a of ADAPTERS) if (await a.detect(root)) hits.push(a);
  // WordPress repos often also have package.json with react for blocks — WP wins as primary.
  if (hits.some((h) => h.id === "wordpress")) return hits.filter((h) => h.id === "wordpress");
  if (hits.some((h) => h.id === "drupal")) return hits.filter((h) => h.id === "drupal");
  return hits;
}

export function frameworkOf(adapters: Adapter[]): Framework {
  if (adapters.length === 0) return "unknown";
  if (adapters.length === 1) return adapters[0].id;
  return "composite";
}
