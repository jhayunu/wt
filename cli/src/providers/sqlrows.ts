/**
 * Just enough SQL parsing to tell "this row was modified" from "one row vanished and a
 * different one appeared".
 *
 * Comparing whole mysqldump statements as opaque strings cannot see that two statements
 * describe the same row, so editing one option counted as two changes. Keying rows by
 * their primary key fixes that, and the primary key is already available: the schema dump
 * the provider takes for the DDL diff.
 */

/** Primary key columns of `table`, from a `mysqldump --no-data` dump. */
export function parsePrimaryKey(schema: string, table: string): string[] | undefined {
  const start = schema.indexOf("CREATE TABLE `" + table + "`");
  if (start === -1) return undefined;
  const next = schema.indexOf("CREATE TABLE `", start + 1);
  const block = schema.slice(start, next === -1 ? undefined : next);
  const m = /PRIMARY KEY \(([^)]+)\)/.exec(block);
  if (!m) return undefined;
  const cols = m[1].split(",").map((c) => c.trim().replace(/^`|`$/g, "").replace(/\(\d+\)$/, ""));
  return cols.length ? cols : undefined;
}

/**
 * Split a SQL value list on top-level commas.
 * Quoted strings may contain commas, doubled quotes and backslash escapes.
 */
export function splitValues(list: string): string[] {
  const out: string[] = [];
  let cur = "", inStr = false, i = 0;
  while (i < list.length) {
    const ch = list[i];
    if (inStr) {
      if (ch === "\\") { cur += ch + (list[i + 1] ?? ""); i += 2; continue; }
      if (ch === "'") {
        if (list[i + 1] === "'") { cur += "''"; i += 2; continue; } // escaped quote
        inStr = false; cur += ch; i++; continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === "'") { inStr = true; cur += ch; i++; continue; }
    if (ch === ",") { out.push(cur.trim()); cur = ""; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface ParsedRow { table: string; columns: string[]; values: string[] }

/** Parse one `REPLACE INTO … (cols) VALUES (…)` produced by `mysqldump --complete-insert`. */
export function parseReplace(stmt: string): ParsedRow | undefined {
  const m = /^\s*REPLACE\s+INTO\s+`([^`]+)`\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*$/is.exec(stmt);
  if (!m) return undefined;
  return {
    table: m[1],
    columns: m[2].split(",").map((c) => c.trim().replace(/^`|`$/g, "")),
    values: splitValues(m[3]),
  };
}

/** The primary-key values of a row, as a stable string, or undefined if it cannot be read. */
export function rowKey(stmt: string, pk: string[]): string | undefined {
  const row = parseReplace(stmt);
  if (!row) return undefined;
  const parts: string[] = [];
  for (const col of pk) {
    const i = row.columns.indexOf(col);
    if (i === -1 || row.values[i] === undefined) return undefined;
    parts.push(row.values[i]);
  }
  return parts.join(" ");
}

export interface RowDelta {
  /** statements to replay: rows that are new or whose contents changed */
  upserts: string[];
  /** statements present at baseline whose row is gone now */
  removed: string[];
  /** distinct rows affected — a modified row counts once, not twice */
  changed: number;
}

/**
 * Compare two dumps of the same table. With a primary key, a modified row is recognised
 * as one row; without one (no PK, or an unparseable dump) this degrades to comparing whole
 * statements, which over-counts modifications but never misses a change.
 */
export function rowDelta(before: string[], after: string[], pk?: string[]): RowDelta {
  if (!pk?.length) {
    const b = new Set(before), a = new Set(after);
    const upserts = after.filter((s) => !b.has(s));
    const removed = before.filter((s) => !a.has(s));
    return { upserts, removed, changed: upserts.length + removed.length };
  }

  const index = (rows: string[]) => {
    const byKey = new Map<string, string>();
    const unkeyed: string[] = [];
    for (const s of rows) {
      const k = rowKey(s, pk);
      if (k === undefined) unkeyed.push(s); else byKey.set(k, s);
    }
    return { byKey, unkeyed };
  };
  const b = index(before), a = index(after);

  const upserts: string[] = [], removed: string[] = [];
  let changed = 0;
  for (const [k, stmt] of a.byKey) {
    const prev = b.byKey.get(k);
    if (prev === undefined || prev !== stmt) { upserts.push(stmt); changed++; }
  }
  for (const [k, stmt] of b.byKey) if (!a.byKey.has(k)) { removed.push(stmt); changed++; }

  // rows we could not key fall back to set comparison so nothing is silently dropped
  const bu = new Set(b.unkeyed), au = new Set(a.unkeyed);
  for (const s of a.unkeyed) if (!bu.has(s)) { upserts.push(s); changed++; }
  for (const s of b.unkeyed) if (!au.has(s)) { removed.push(s); changed++; }

  return { upserts, removed, changed };
}
