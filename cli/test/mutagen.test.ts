import test from "node:test";
import assert from "node:assert/strict";
import { uploadDirEntry, planExclusion } from "../src/core/mutagen.js";

// DDEV resolves upload_dirs relative to the docroot, not the approot — verified on
// v1.25.1: `.wt/worktrees` under `docroot: public` produced an ignore of
// `/public/.wt/worktrees`, which excludes nothing, while `../.wt/worktrees` produced
// `/.wt/worktrees` and the bind-mount we want.
test("the entry is docroot-relative, not approot-relative", () => {
  assert.equal(uploadDirEntry("public", ".wt/worktrees"), "../.wt/worktrees");
  assert.equal(uploadDirEntry("web", ".wt/worktrees"), "../.wt/worktrees");
  assert.equal(uploadDirEntry("web/sites", ".wt/worktrees"), "../../.wt/worktrees");
});

test("a docroot at the approot needs no climbing", () => {
  for (const docroot of [".", "", undefined, "./"]) {
    assert.equal(uploadDirEntry(docroot, ".wt/worktrees"), ".wt/worktrees", `docroot: ${String(docroot)}`);
  }
});

test("a custom worktrees_dir is honoured", () => {
  assert.equal(uploadDirEntry("public", "worktrees"), "../worktrees");
  assert.equal(uploadDirEntry(".", "tmp/wt"), "tmp/wt");
});

test("our entry goes last, so import-files keeps its target", () => {
  // `ddev import-files` and DDEV_FILES_DIR use the first entry — appending must not steal it
  const p = planExclusion("public", ".wt/worktrees", ["storage/app/public"]);
  assert.deepEqual(p.uploadDirs, ["storage/app/public", "../.wt/worktrees"]);
  assert.equal(p.present, false);
});

test("existing entries are never dropped", () => {
  // upload_dirs in config.wt.local.yaml replaces the list rather than extending it, so
  // rewriting it without the project's own directories would stop excluding them
  const p = planExclusion("web", ".wt/worktrees", ["sites/default/files", "../private"]);
  assert.deepEqual(p.uploadDirs, ["sites/default/files", "../private", "../.wt/worktrees"]);
});

test("an already-excluded directory is left alone", () => {
  const p = planExclusion("public", ".wt/worktrees", ["../.wt/worktrees"]);
  assert.equal(p.present, true);
  assert.deepEqual(p.uploadDirs, ["../.wt/worktrees"]);
});

test("equivalent spellings count as present", () => {
  for (const spelling of ["../.wt/worktrees/", "../foo/../.wt/worktrees", " ../.wt/worktrees "]) {
    assert.equal(planExclusion("public", ".wt/worktrees", [spelling]).present, true, spelling);
  }
});

test("with no upload_dirs at all we still produce a one-entry list", () => {
  assert.deepEqual(planExclusion("public", ".wt/worktrees", undefined).uploadDirs, ["../.wt/worktrees"]);
});
