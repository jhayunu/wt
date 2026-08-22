import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { ensureClaudeMd, CLAUDE_MARKER, CLAUDE_MARKER_END, GLOBAL_BLOCK } from "../src/core/claudemd.js";

async function tmpFile(contents?: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wt-claudemd-"));
  const file = path.join(dir, "CLAUDE.md");
  if (contents !== undefined) await writeFile(file, contents);
  return file;
}

test("adds the block to a missing or empty CLAUDE.md", async () => {
  const file = await tmpFile();
  assert.equal(await ensureClaudeMd(file, GLOBAL_BLOCK), "added");
  const out = await readFile(file, "utf8");
  assert.match(out, /## Worktrees \(wt\)/);
  assert.ok(out.includes(CLAUDE_MARKER) && out.includes(CLAUDE_MARKER_END));
});

test("re-running with the same block is a no-op", async () => {
  const file = await tmpFile();
  await ensureClaudeMd(file, GLOBAL_BLOCK);
  const first = await readFile(file, "utf8");
  assert.equal(await ensureClaudeMd(file, GLOBAL_BLOCK), "present");
  assert.equal(await readFile(file, "utf8"), first);
});

test("an older block is replaced in place, not appended beside", async () => {
  const stale = [CLAUDE_MARKER, "## Worktrees (wt)", "", "Some rule from an earlier version.", CLAUDE_MARKER_END].join("\n");
  const file = await tmpFile(`# Instructions\n\nMy own preamble.\n\n${stale}\n\n## My section\n\nKeep me.\n`);

  assert.equal(await ensureClaudeMd(file, GLOBAL_BLOCK), "updated");
  const out = await readFile(file, "utf8");
  assert.ok(!out.includes("Some rule from an earlier version"), "stale rule text survived");
  assert.equal(out.match(/## Worktrees \(wt\)/g)?.length, 1, "block was duplicated instead of replaced");
  assert.match(out, /My own preamble\./);
  assert.match(out, /## My section\n\nKeep me\./, "content after the block must be preserved");
});

test("a legacy block with no end marker is replaced without eating what follows", async () => {
  // Blocks written before CLAUDE_MARKER_END existed have only an opening marker.
  const legacy = [CLAUDE_MARKER, "## Worktrees (wt)", "", "Never edit files in the main checkout.", ""].join("\n");
  const file = await tmpFile(`# Instructions\n\n${legacy}\n## Unrelated\n\nMine.\n`);

  assert.equal(await ensureClaudeMd(file, GLOBAL_BLOCK), "updated");
  const out = await readFile(file, "utf8");
  assert.ok(!out.includes("Never edit files in the main checkout"), "legacy rule text survived");
  assert.match(out, /## Unrelated\n\nMine\./, "the user's own section was swallowed");
  assert.ok(out.includes(CLAUDE_MARKER_END), "replacement should leave an end marker behind");
});

test("a legacy block at end of file is replaced", async () => {
  const legacy = [CLAUDE_MARKER, "## Worktrees (wt)", "", "Old text."].join("\n");
  const file = await tmpFile(`# Instructions\n\nPreamble.\n\n${legacy}\n`);

  assert.equal(await ensureClaudeMd(file, GLOBAL_BLOCK), "updated");
  const out = await readFile(file, "utf8");
  assert.ok(!out.includes("Old text."));
  assert.match(out, /Preamble\./);
  assert.ok(out.endsWith("\n"), "file should keep a trailing newline");
});
