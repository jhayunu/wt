import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/core/git.js";
import { inferLevel } from "../src/core/planner.js";
import { RepoConfigSchema } from "../src/core/config.js";

test("slugify is DNS safe", () => {
  assert.equal(slugify("feat/Checkout Page"), "feat-checkout-page");
  assert.ok(slugify("x".repeat(80)).length <= 50);
});

test("inferLevel: floor, hints, explicit, clamp", () => {
  const cfg = RepoConfigSchema.parse({ main: "m", min_level: 1, max_level: 3 });
  const wp = { id: "wordpress", floorLevel: () => 2 } as any;
  const react = { id: "react", floorLevel: () => 0 } as any;
  assert.equal(inferLevel(cfg, [react], undefined, "fix typo").level, 1);          // clamped up to min
  assert.equal(inferLevel(cfg, [react], undefined, "add migration").level, 2);     // hint
  assert.equal(inferLevel(cfg, [wp], undefined, "import media").level, 3);         // hint beats floor
  assert.equal(inferLevel(cfg, [wp], 4, undefined).level, 3);                       // clamped to max
});
