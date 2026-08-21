import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { urlFor } from "../src/core/ddevconfig.js";
import { loadRepoConfig, RepoConfigSchema } from "../src/core/config.js";
import { makeRecord } from "../src/commands/new.js";

const envWith = (cfg: any) => ({ repoRoot: "/repo", cfg, adapters: [{ id: "laravel" }] }) as any;

test("urlFor carries main's tld and router port over to the worktree", () => {
  assert.equal(urlFor("feat-x", "ddev.site"), "https://feat-x.ddev.site");
  assert.equal(urlFor("feat-x", "ddev.site", "https://myshop.ddev.site"), "https://feat-x.ddev.site");
  assert.equal(urlFor("feat-x", "ddev.site", "https://myshop.ddev.site:444"), "https://feat-x.ddev.site:444");
  assert.equal(urlFor("feat-x", "ddev.site", "https://myshop.ddev.local"), "https://feat-x.ddev.local");
  assert.equal(urlFor("feat-x", "wt.test", "not a url"), "https://feat-x.wt.test");
});

test("makeRecord: level 4 is clean (fresh db, empty media), level 3 copies media", () => {
  const cfg = RepoConfigSchema.parse({ main: "m" });
  const env = envWith(cfg);
  const l4 = makeRecord(env, "n", "wt/n", 4, {});
  assert.equal(l4.db, "fresh");
  assert.equal(l4.media, "none", "level 4 must not inherit level 3's media: copy");
  assert.equal(makeRecord(env, "n", "wt/n", 3, {}).media, "copy");
  assert.equal(makeRecord(env, "n", "wt/n", 2, {}).media, cfg.defaults.media);
  const l1 = makeRecord(env, "n", "wt/n", 1, {});
  assert.equal(l1.url, "", "levels below 2 have no environment of their own");
  assert.equal(l1.db, "none");
});

test("makeRecord derives the URL from main's primary URL when it has one", () => {
  const env = envWith(RepoConfigSchema.parse({ main: "m" }));
  assert.equal(makeRecord(env, "feat-x", "feat/x", 2, {}, "https://m.ddev.site:444").url, "https://feat-x.ddev.site:444");
});

test("loadRepoConfig takes main/tld from .ddev/config.yaml, and .wt.yml wins over it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wt-cfg-"));
  await mkdir(path.join(root, ".ddev"), { recursive: true });
  await writeFile(path.join(root, ".ddev", "config.yaml"), "name: lara-pelikan\ntype: laravel\nproject_tld: ddev.local\n");
  const fromDdev = await loadRepoConfig(root);
  assert.equal(fromDdev.main, "lara-pelikan", "a repo that pins its DDEV name must not default to the directory name");
  assert.equal(fromDdev.tld, "ddev.local");
  await writeFile(path.join(root, ".wt.yml"), "main: explicit\n");
  assert.equal((await loadRepoConfig(root)).main, "explicit");
});

import { declaredDeps, depHint, missingDeps, toolArgv } from "../src/core/deps.js";
import { laravel } from "../src/adapters/laravel.js";
import { react } from "../src/adapters/react.js";

test("toolArgv routes by level: own project vs main's container", () => {
  const l1 = { level: 1, path: "/repo/.wt/worktrees/x" } as any;
  const l2 = { level: 2, path: "/repo/.wt/worktrees/x" } as any;
  assert.deepEqual(toolArgv("/repo", l2, "composer", ["install"]), { argv: ["composer", "install"], cwd: "/repo/.wt/worktrees/x" });
  assert.deepEqual(toolArgv("/repo", l1, "composer", ["install"]),
    { argv: ["exec", "--dir", "/var/www/html/.wt/worktrees/x", "composer", "install"], cwd: "/repo" });
  // `artisan` is a ddev shortcut; inside exec it has to be spelled out
  assert.deepEqual(toolArgv("/repo", l1, "artisan", ["migrate"]).argv.slice(3), ["php", "artisan", "migrate"]);
  assert.deepEqual(toolArgv("/repo", l1, null, ["ls"]).argv, ["exec", "--dir", "/var/www/html/.wt/worktrees/x", "ls"]);
});

test("dependencies: a fresh worktree reports what git did not carry", () => {
  const adapters = [laravel, react] as any;
  assert.deepEqual(declaredDeps(adapters).map((d) => d.marker), ["vendor/autoload.php", "node_modules"]);
  const rec = { name: "feat-x", path: "/nonexistent/worktree", level: 1 } as any;
  const missing = missingDeps(rec, adapters);
  assert.equal(missing.length, 2, "nothing is installed in a path that does not exist");
  const hint = depHint(rec, missing);
  assert.match(hint, /wt composer feat-x -- install --no-scripts/);
  assert.match(hint, /wt npm feat-x -- ci/);
});
