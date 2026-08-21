import test from "node:test";
import assert from "node:assert/strict";
import { parsePrimaryKey, splitValues, parseReplace, rowKey, rowDelta } from "../src/providers/sqlrows.js";

const SCHEMA = [
  "CREATE TABLE `wp_options` (",
  "  `option_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,",
  "  `option_name` varchar(191) NOT NULL DEFAULT '',",
  "  PRIMARY KEY (`option_id`),",
  "  UNIQUE KEY `option_name` (`option_name`)",
  ") ENGINE=InnoDB;",
  "CREATE TABLE `wp_term_relationships` (",
  "  `object_id` bigint(20) unsigned NOT NULL DEFAULT 0,",
  "  `term_taxonomy_id` bigint(20) unsigned NOT NULL DEFAULT 0,",
  "  PRIMARY KEY (`object_id`,`term_taxonomy_id`)",
  ") ENGINE=InnoDB;",
  "CREATE TABLE `no_pk` (",
  "  `a` int DEFAULT NULL",
  ") ENGINE=InnoDB;",
].join("\n");

const opt = (id: number, name: string, val: string) =>
  "REPLACE INTO `wp_options` (`option_id`, `option_name`, `option_value`) VALUES " +
  `(${id},'${name}','${val}')`;

test("parsePrimaryKey reads single and composite keys, and reports none", () => {
  assert.deepEqual(parsePrimaryKey(SCHEMA, "wp_options"), ["option_id"]);
  assert.deepEqual(parsePrimaryKey(SCHEMA, "wp_term_relationships"), ["object_id", "term_taxonomy_id"]);
  assert.equal(parsePrimaryKey(SCHEMA, "no_pk"), undefined);
  assert.equal(parsePrimaryKey(SCHEMA, "not_a_table"), undefined);
});

test("parsePrimaryKey does not read the next table's key", () => {
  // wp_options must not pick up wp_term_relationships' composite key
  assert.deepEqual(parsePrimaryKey(SCHEMA, "wp_options"), ["option_id"]);
});

test("splitValues ignores commas inside quoted strings", () => {
  assert.deepEqual(splitValues("1,'a,b','c'"), ["1", "'a,b'", "'c'"]);
});

test("splitValues survives escaped and doubled quotes", () => {
  assert.deepEqual(splitValues(String.raw`1,'it\'s','a''b'`), ["1", String.raw`'it\'s'`, "'a''b'"]);
  // a backslash-escaped quote must not end the string and leak a false separator
  assert.equal(splitValues(String.raw`'x\',y','z'`).length, 2);
});

test("parseReplace pulls out table, columns and values", () => {
  const r = parseReplace(opt(5, "blogdescription", "hello"))!;
  assert.equal(r.table, "wp_options");
  assert.deepEqual(r.columns, ["option_id", "option_name", "option_value"]);
  assert.deepEqual(r.values, ["5", "'blogdescription'", "'hello'"]);
});

test("parseReplace returns undefined for anything that is not a row", () => {
  assert.equal(parseReplace("SET @OLD_AUTOCOMMIT=@@AUTOCOMMIT"), undefined);
});

test("rowKey uses the primary key columns, in order", () => {
  assert.equal(rowKey(opt(5, "x", "y"), ["option_id"]), "5");
  assert.equal(rowKey(opt(5, "x", "y"), ["option_name"]), "'x'");
  assert.equal(rowKey(opt(5, "x", "y"), ["nope"]), undefined);
});

test("a modified row counts once, not twice", () => {
  const before = [opt(1, "a", "old"), opt(2, "b", "keep")];
  const after = [opt(1, "a", "new"), opt(2, "b", "keep")];
  const d = rowDelta(before, after, ["option_id"]);
  assert.equal(d.changed, 1, "one edit is one change");
  assert.deepEqual(d.upserts, [opt(1, "a", "new")]);
  assert.deepEqual(d.removed, []);
});

test("added and removed rows are classified apart", () => {
  const before = [opt(1, "a", "x"), opt(2, "b", "y")];
  const after = [opt(1, "a", "x"), opt(3, "c", "z")];
  const d = rowDelta(before, after, ["option_id"]);
  assert.equal(d.changed, 2);
  assert.deepEqual(d.upserts, [opt(3, "c", "z")]);
  assert.deepEqual(d.removed, [opt(2, "b", "y")]);
});

test("no change means no delta", () => {
  const rows = [opt(1, "a", "x")];
  const d = rowDelta(rows, [...rows], ["option_id"]);
  assert.deepEqual(d, { upserts: [], removed: [], changed: 0 });
});

test("without a primary key it degrades to statement comparison", () => {
  const before = [opt(1, "a", "old")];
  const after = [opt(1, "a", "new")];
  const d = rowDelta(before, after, undefined);
  // over-counts a modification, but never misses it
  assert.equal(d.changed, 2);
  assert.deepEqual(d.upserts, [opt(1, "a", "new")]);
  assert.deepEqual(d.removed, [opt(1, "a", "old")]);
});

test("composite primary keys work", () => {
  const rel = (o: number, t: number, extra: string) =>
    "REPLACE INTO `wp_term_relationships` (`object_id`, `term_taxonomy_id`, `term_order`) VALUES " +
    `(${o},${t},'${extra}')`;
  const d = rowDelta([rel(1, 2, "a"), rel(1, 3, "a")], [rel(1, 2, "b"), rel(1, 3, "a")],
    ["object_id", "term_taxonomy_id"]);
  assert.equal(d.changed, 1);
  assert.deepEqual(d.upserts, [rel(1, 2, "b")]);
});

test("rows that cannot be keyed still get compared", () => {
  const weird = "REPLACE INTO `wp_options` (`other`) VALUES (1)";
  const d = rowDelta([], [weird], ["option_id"]);
  assert.equal(d.changed, 1, "an unkeyable row must not be silently dropped");
  assert.deepEqual(d.upserts, [weird]);
});
