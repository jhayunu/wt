import { EXIT, WtError, type RepoConfig } from "../core/types.js";

/**
 * Row-level deny lists for key/value tables.
 *
 * `deny_tables` can only exclude a whole table, which is useless for `wp_options`:
 * it holds both the settings a reviewer wants to see and secrets (`mailserver_pass`,
 * `recovery_keys`) plus rows that churn on their own (`cron`, `_transient_*`).
 * Exporting the table wholesale leaks the first and guarantees a dirty diff from
 * the second, so the filter has to work per row.
 *
 * Config shape — `<table>.<column>: [pattern, …]`:
 *
 *   db:
 *     deny_rows:
 *       wp_options.option_name: ["cron", "mailserver_pass", "_transient_%"]
 *
 * A pattern is either exact (`cron`) or a prefix (`_transient_%`). Only a trailing
 * `%` is a wildcard; everything else is literal. That is deliberately narrower than
 * SQL `LIKE`, because `LIKE` also treats `_` as a wildcard — and every realistic
 * pattern here (`_transient_%`) starts with a literal underscore, which is exactly
 * the character that would silently turn into "any character".
 */

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

/**
 * `ddev exec` runs its argument through bash, so anything that reaches the WHERE clause
 * is shell input as well as SQL. Backtick-quoting an identifier the way MySQL wants would
 * be command substitution to bash — it silently deletes the column name. So: no backticks
 * anywhere, and both halves are validated instead of escaped.
 */
const IDENT = /^[A-Za-z0-9_]+$/;
const SHELL_UNSAFE = /[`$\\\n\r]/;

export interface DenyPatterns { exact: string[]; prefixes: string[] }

export function parseDeny(patterns: string[], key: string): DenyPatterns {
  const exact: string[] = [], prefixes: string[] = [];
  for (const p of patterns) {
    const star = p.indexOf("%");
    if (star === -1) exact.push(p);
    else if (star === p.length - 1) prefixes.push(p.slice(0, -1));
    else throw new WtError(EXIT.GENERIC, `db.deny_rows.${key}: "${p}" — % is only supported at the end`, 'use an exact name ("cron") or a prefix ("_transient_%")');
    if (SHELL_UNSAFE.test(p)) throw new WtError(EXIT.GENERIC, `db.deny_rows.${key}: "${p}" contains a character that is unsafe to pass through ddev exec`, "remove ` $ \\ and newlines from the pattern");
  }
  return { exact, prefixes };
}

/** The deny patterns configured for one table, or undefined. Keys are `<table>.<column>`. */
export function denyFor(cfg: RepoConfig, table: string): { column: string; patterns: DenyPatterns } | undefined {
  for (const [k, pats] of Object.entries(cfg.db.deny_rows ?? {})) {
    const dot = k.indexOf(".");
    if (dot <= 0) throw new WtError(EXIT.GENERIC, `db.deny_rows: "${k}" is not <table>.<column>`, 'e.g. wp_options.option_name');
    if (k.slice(0, dot) !== table) continue;
    const column = k.slice(dot + 1);
    if (!IDENT.test(column)) throw new WtError(EXIT.GENERIC, `db.deny_rows: "${k}" — "${column}" is not a plain column name`, "letters, digits and underscore only");
    if (!pats.length) return undefined;
    return { column, patterns: parseDeny(pats, k) };
  }
  return undefined;
}

/**
 * A SQL predicate keeping only the rows that are NOT denied, for `mysqldump --where`.
 * Prefixes use LEFT() rather than NOT LIKE so no escaping question arises at all:
 * the value is compared literally, and `_` cannot act as a wildcard.
 */
export function denyWhere(d: { column: string; patterns: DenyPatterns } | undefined): string | undefined {
  if (!d) return undefined;
  const col = d.column; // validated by denyFor(): plain identifier, safe unquoted
  const parts: string[] = [];
  if (d.patterns.exact.length) parts.push(`${col} NOT IN (${d.patterns.exact.map(quote).join(", ")})`);
  for (const p of d.patterns.prefixes) parts.push(`LEFT(${col}, ${[...p].length}) <> ${quote(p)}`);
  return parts.length ? parts.join(" AND ") : undefined;
}

/** Same rule applied in JS, for providers that filter a result set rather than a dump. */
export function isDenied(cfg: RepoConfig, table: string, value: string): boolean {
  const d = denyFor(cfg, table);
  if (!d) return false;
  return d.patterns.exact.includes(value) || d.patterns.prefixes.some((p) => value.startsWith(p));
}
