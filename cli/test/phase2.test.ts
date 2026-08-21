import { test } from "node:test";
import assert from "node:assert/strict";
import { ddlDiff, parseSchema } from "../src/providers/ddl-diff.js";
import { RepoConfigSchema } from "../src/core/config.js";
import { assertCanCreate, assertCanDestroy } from "../src/core/policy.js";

const A = `CREATE TABLE \`orders\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`total\` decimal(10,2) NOT NULL,
  \`status\` varchar(20) NOT NULL DEFAULT 'new',
  PRIMARY KEY (\`id\`),
  KEY \`status_idx\` (\`status\`)
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4;
CREATE TABLE \`legacy\` (
  \`id\` int NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;`;

const B = `CREATE TABLE \`orders\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`user_id\` bigint unsigned NOT NULL,
  \`total\` decimal(12,2) NOT NULL,
  \`status\` varchar(20) NOT NULL DEFAULT 'new',
  PRIMARY KEY (\`id\`),
  KEY \`status_idx\` (\`status\`),
  KEY \`user_idx\` (\`user_id\`),
  CONSTRAINT \`orders_user_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=99 DEFAULT CHARSET=utf8mb4;
CREATE TABLE \`coupons\` (
  \`code\` varchar(32) NOT NULL,
  PRIMARY KEY (\`code\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;

test("parseSchema ignores AUTO_INCREMENT counters", () => {
  const t = parseSchema(A).get("orders")!;
  assert.equal(t.columnOrder.length, 3);
  assert.ok(!t.options.includes("AUTO_INCREMENT"));
  assert.ok(t.keys.has("PRIMARY") && t.keys.has("status_idx"));
});

test("ddlDiff emits create/drop/alter", () => {
  const out = ddlDiff(A, B).join("\n");
  assert.match(out, /CREATE TABLE `coupons`/);
  assert.match(out, /DROP TABLE `legacy`/);
  assert.match(out, /ADD COLUMN `user_id` bigint unsigned NOT NULL AFTER `id`/);
  assert.match(out, /MODIFY COLUMN `total` decimal\(12,2\) NOT NULL/);
  assert.match(out, /ADD KEY `user_idx`/);
  assert.match(out, /ADD CONSTRAINT `orders_user_fk`/);
  assert.equal(ddlDiff(B, B).length, 0, "identical schemas → no statements");
});

test("policy: levels, task requirement, ownership lease", () => {
  const cfg = RepoConfigSchema.parse({ main: "m", policy: { allow_levels: [0, 2], require_task: true } });
  assert.throws(() => assertCanCreate(cfg, 3, "x"), /level 3 not allowed/);
  assert.throws(() => assertCanCreate(cfg, 2, undefined), /--task is required/);
  assertCanCreate(cfg, 2, "fine");
  const rec: any = { name: "a", owner: "someone-else", leaseUntil: new Date(Date.now() + 3600e3).toISOString() };
  assert.throws(() => assertCanDestroy(cfg, rec, false), /owned by someone-else/);
  assertCanDestroy(cfg, rec, true);
  assertCanDestroy(cfg, { ...rec, leaseUntil: new Date(Date.now() - 1).toISOString() }, false);
  assertCanDestroy(RepoConfigSchema.parse({ main: "m", policy: { allow_destroy: "any" } }), rec, false);
});
