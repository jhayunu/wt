import test from "node:test";
import assert from "node:assert/strict";
import { parseDeny, denyFor, denyWhere, isDenied } from "../src/providers/deny.js";
import { statementDelta } from "../src/providers/snapshot-diff.js";
import path from "node:path";
import type { RepoConfig } from "../src/core/types.js";

const cfg = (deny_rows: Record<string, string[]>) =>
  ({ db: { deny_rows } } as unknown as RepoConfig);

const WP = cfg({ "wp_options.option_name": ["cron", "mailserver_pass", "_transient_%"] });

test("parseDeny splits exact names from prefixes", () => {
  const d = parseDeny(["cron", "_transient_%"], "wp_options.option_name");
  assert.deepEqual(d.exact, ["cron"]);
  assert.deepEqual(d.prefixes, ["_transient_"]);
});

test("parseDeny rejects a % that is not at the end", () => {
  assert.throws(() => parseDeny(["%foo%"], "k"), /only supported at the end/);
});

test("denyWhere keeps everything except the denied rows", () => {
  const w = denyWhere(denyFor(WP, "wp_options"))!;
  assert.match(w, /option_name NOT IN \('cron', 'mailserver_pass'\)/);
  // LEFT() rather than NOT LIKE: `_` must stay literal, not become a wildcard
  assert.match(w, /LEFT\(option_name, 11\) <> '_transient_'/);
  assert.ok(!w.includes("LIKE"), "must not use LIKE — `_` would match any character");
  // ddev exec pipes this through bash: a backtick would become command substitution
  assert.ok(!w.includes("`"), "must not backtick-quote identifiers — ddev exec runs via bash");
});

test("denyWhere escapes quotes in a pattern", () => {
  const w = denyWhere(denyFor(cfg({ "t.c": ["it's"] }), "t"))!;
  assert.match(w, /'it''s'/);
});

test("deny config that is unsafe to pass through a shell is rejected", () => {
  assert.throws(() => parseDeny(["$(whoami)"], "k"), /unsafe to pass through/);
  assert.throws(() => parseDeny(["a`b`"], "k"), /unsafe to pass through/);
  assert.throws(() => denyFor(cfg({ "t.c; DROP": ["x"] }), "t"), /not a plain column name/);
});

test("denyWhere is undefined for a table with no rules", () => {
  assert.equal(denyWhere(denyFor(WP, "wp_posts")), undefined);
});

test("isDenied matches exact names and prefixes only", () => {
  assert.equal(isDenied(WP, "wp_options", "cron"), true);
  assert.equal(isDenied(WP, "wp_options", "mailserver_pass"), true);
  assert.equal(isDenied(WP, "wp_options", "_transient_foo"), true);
  assert.equal(isDenied(WP, "wp_options", "blogdescription"), false);
  // would have matched if `_` were treated as a LIKE wildcard
  assert.equal(isDenied(WP, "wp_options", "Xtransient_foo"), false);
  assert.equal(isDenied(WP, "wp_posts", "cron"), false);
});

test("statementDelta returns only what changed, not the whole table", () => {
  const before = ["REPLACE INTO `t` VALUES (1,'a')", "REPLACE INTO `t` VALUES (2,'b')"];
  const after = ["REPLACE INTO `t` VALUES (1,'a')", "REPLACE INTO `t` VALUES (2,'CHANGED')", "REPLACE INTO `t` VALUES (3,'c')"];
  const d = statementDelta(before, after);
  assert.deepEqual(d.upserts, ["REPLACE INTO `t` VALUES (2,'CHANGED')", "REPLACE INTO `t` VALUES (3,'c')"]);
  assert.deepEqual(d.removed, ["REPLACE INTO `t` VALUES (2,'b')"]);
});

test("statementDelta is empty when nothing changed", () => {
  const rows = ["REPLACE INTO `t` VALUES (1,'a')"];
  const d = statementDelta(rows, [...rows]);
  assert.deepEqual(d.upserts, []);
  assert.deepEqual(d.removed, []);
});

test("withRepoLock is re-entrant within one process", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const { withRepoLock } = await import("../src/core/lock.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "wt-lock-"));
  let inner = false;
  // the inner call must not wait on the lock its own caller holds (wt finish → cmdDestroy)
  await withRepoLock(dir, async () => {
    await withRepoLock(dir, async () => { inner = true; });
  });
  assert.equal(inner, true);
  // and the lock must be genuinely released afterwards
  await withRepoLock(dir, async () => { inner = false; });
  assert.equal(inner, false);
});
