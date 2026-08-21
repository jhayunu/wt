/**
 * Minimal MySQL/MariaDB DDL differ. Input: two `mysqldump --no-data` outputs.
 * Output: ALTER/CREATE/DROP statements that take schema A to schema B.
 *
 * Handles columns (add/drop/modify), indexes & unique keys (add/drop), primary key,
 * foreign keys (drop/add), and whole tables. Good enough for review and for replay
 * on a same-engine target; not a replacement for Liquibase on exotic schemas.
 */
export interface TableDef {
  name: string;
  columns: Map<string, string>;      // name -> full definition text
  columnOrder: string[];
  keys: Map<string, string>;         // key name ("PRIMARY" | idx name | fk name) -> definition text
  options: string;                   // trailing ENGINE=… CHARSET=… (AUTO_INCREMENT stripped)
}

export function parseSchema(sql: string): Map<string, TableDef> {
  const tables = new Map<string, TableDef>();
  const re = /CREATE TABLE\s+`?([^`\s(]+)`?\s*\(([\s\S]*?)\n\)\s*([^;]*);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const def: TableDef = { name: m[1], columns: new Map(), columnOrder: [], keys: new Map(), options: m[3].replace(/\s*AUTO_INCREMENT=\d+/i, "").trim() };
    for (const rawLine of splitTopLevel(m[2])) {
      const line = rawLine.trim().replace(/,$/, "");
      if (!line) continue;
      if (/^PRIMARY KEY/i.test(line)) def.keys.set("PRIMARY", norm(line));
      else if (/^(UNIQUE KEY|KEY|INDEX|FULLTEXT KEY|SPATIAL KEY)\s+`?([^`\s(]+)`?/i.test(line)) {
        const k = /^(?:UNIQUE KEY|KEY|INDEX|FULLTEXT KEY|SPATIAL KEY)\s+`?([^`\s(]+)`?/i.exec(line)![1];
        def.keys.set(k, norm(line));
      } else if (/^CONSTRAINT\s+`?([^`\s]+)`?/i.test(line)) {
        const k = /^CONSTRAINT\s+`?([^`\s]+)`?/i.exec(line)![1];
        def.keys.set(`fk:${k}`, norm(line));
      } else {
        const c = /^`?([^`\s]+)`?\s+([\s\S]+)$/.exec(line);
        if (c) { def.columns.set(c[1], norm(c[2])); def.columnOrder.push(c[1]); }
      }
    }
    tables.set(def.name, def);
  }
  return tables;
}

function splitTopLevel(body: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "\n" && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const q = (s: string) => `\`${s}\``;

export function diffSchemas(a: Map<string, TableDef>, b: Map<string, TableDef>): string[] {
  const out: string[] = [];
  for (const [name, t] of b) if (!a.has(name)) {
    const cols = t.columnOrder.map((c) => `  ${q(c)} ${t.columns.get(c)}`);
    const keys = [...t.keys.values()].map((k) => `  ${k}`);
    out.push(`CREATE TABLE ${q(name)} (\n${[...cols, ...keys].join(",\n")}\n) ${t.options};`);
  }
  for (const name of a.keys()) if (!b.has(name)) out.push(`DROP TABLE ${q(name)};`);
  for (const [name, tb] of b) {
    const ta = a.get(name); if (!ta) continue;
    const alters: string[] = [];
    // foreign keys first (drop), so column changes don't trip constraints
    for (const [k, v] of ta.keys) if (k.startsWith("fk:") && tb.keys.get(k) !== v) alters.push(`DROP FOREIGN KEY ${q(k.slice(3))}`);
    for (const [k] of ta.keys) if (!k.startsWith("fk:") && !tb.keys.has(k)) alters.push(k === "PRIMARY" ? "DROP PRIMARY KEY" : `DROP INDEX ${q(k)}`);
    for (const [k, v] of ta.keys) if (!k.startsWith("fk:") && tb.keys.has(k) && tb.keys.get(k) !== v) alters.push(k === "PRIMARY" ? "DROP PRIMARY KEY" : `DROP INDEX ${q(k)}`);
    for (const c of ta.columnOrder) if (!tb.columns.has(c)) alters.push(`DROP COLUMN ${q(c)}`);
    tb.columnOrder.forEach((c, i) => {
      const pos = i === 0 ? " FIRST" : ` AFTER ${q(tb.columnOrder[i - 1])}`;
      if (!ta.columns.has(c)) alters.push(`ADD COLUMN ${q(c)} ${tb.columns.get(c)}${pos}`);
      else if (ta.columns.get(c) !== tb.columns.get(c)) alters.push(`MODIFY COLUMN ${q(c)} ${tb.columns.get(c)}`);
    });
    for (const [k, v] of tb.keys) if (!k.startsWith("fk:") && (ta.keys.get(k) !== v)) alters.push(`ADD ${v}`);
    for (const [k, v] of tb.keys) if (k.startsWith("fk:") && ta.keys.get(k) !== v) alters.push(`ADD ${v}`);
    if (ta.options !== tb.options && tb.options) alters.push(tb.options.replace(/\s+(DEFAULT CHARSET|COLLATE|COMMENT)=/g, " $1="));
    if (alters.length) out.push(`ALTER TABLE ${q(name)}\n  ${alters.join(",\n  ")};`);
  }
  return out;
}

export function ddlDiff(beforeSql: string, afterSql: string): string[] {
  return diffSchemas(parseSchema(beforeSql), parseSchema(afterSql));
}
