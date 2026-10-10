import type { Database } from "bun:sqlite";

/** One table's structure as the pragmas report it (spec §7.3). Text is never compared: comments,
 *  ADD COLUMN text and a rebuild's quoted rename all differ while the structure is the same. */
export interface TableShape {
  columns: string[];
  indexes: string[];
  foreignKeys: string[];
  autoincrement: boolean;
}
export interface SchemaShape {
  tables: Record<string, TableShape>;
  views: Record<string, string>;
  triggers: Record<string, string>;
}

function closingQuote(sql: string, start: number): number {
  const q = sql[start];
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === q) {
      if (sql[i + 1] === q) {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return sql.length - 1;
}

/** Remove `--` and block comments outside string literals and quoted identifiers. */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = closingQuote(sql, i);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Comments removed, whitespace collapsed, no spaces around punctuation. */
export function normalizeSql(sql: string): string {
  return stripSqlComments(sql)
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;=])\s*/g, "$1")
    .trim();
}

type Row = Record<string, unknown>;
const lit = (name: string): string => `'${name.replaceAll("'", "''")}'`;

export function describeSchema(db: Database): SchemaShape {
  const master = db
    .query<{ type: string; name: string; sql: string | null }, []>(
      "SELECT type, name, sql FROM sqlite_master ORDER BY type, name",
    )
    .all();
  const tables: Record<string, TableShape> = {};
  for (const t of master.filter((m) => m.type === "table" && !m.name.startsWith("sqlite_"))) {
    const pragma = (name: string): Row[] =>
      db.query<Row, []>(`PRAGMA ${name}(${lit(t.name)})`).all();
    const columns = pragma("table_xinfo").map(
      (c) =>
        `${c.cid}|${c.name}|${c.type}|notnull=${c.notnull}|default=${c.dflt_value}|pk=${c.pk}|hidden=${c.hidden}`,
    );
    const indexes = pragma("index_list")
      .map((ix) => {
        const cols = db
          .query<Row, []>(`PRAGMA index_xinfo(${lit(String(ix.name))})`)
          .all()
          .filter((c) => c.key === 1)
          .map((c) => `${c.name}:${c.desc}:${c.coll}`)
          .join(",");
        const own = master.find((m) => m.type === "index" && m.name === ix.name)?.sql ?? null;
        const at = own === null ? -1 : own.search(/\bWHERE\b/i);
        const where =
          own !== null && Number(ix.partial) === 1 && at >= 0 ? normalizeSql(own.slice(at)) : "";
        // Automatic indexes are named after the table they were created on, which a rebuild changes.
        const label = ix.origin === "c" ? String(ix.name) : `(${ix.origin})`;
        return `${label}|unique=${ix.unique}|partial=${ix.partial}|cols=${cols}|${where}`;
      })
      .sort();
    const foreignKeys = pragma("foreign_key_list")
      .map(
        (f) =>
          `${f.id}|${f.seq}|${f.table}|${f.from}|${f.to}|${f.on_update}|${f.on_delete}|${f.match}`,
      )
      .sort();
    const autoincrement = /\bAUTOINCREMENT\b/i.test(stripSqlComments(t.sql ?? ""));
    tables[t.name] = { columns, indexes, foreignKeys, autoincrement };
  }
  const named = (type: string): Record<string, string> =>
    Object.fromEntries(
      master.filter((m) => m.type === type).map((m) => [m.name, normalizeSql(m.sql ?? "")]),
    );
  return { tables, views: named("view"), triggers: named("trigger") };
}

export function diffShapes(expected: SchemaShape, actual: SchemaShape): string[] {
  const out: string[] = [];
  const names = [
    ...new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)]),
  ].sort();
  for (const n of names) {
    const e = expected.tables[n];
    const a = actual.tables[n];
    if (!e) {
      out.push(`table ${n}: present but not expected`);
      continue;
    }
    if (!a) {
      out.push(`table ${n}: missing`);
      continue;
    }
    for (const key of ["columns", "indexes", "foreignKeys"] as const) {
      const ej = JSON.stringify(e[key]);
      const aj = JSON.stringify(a[key]);
      if (ej !== aj) out.push(`table ${n}: ${key} differ\n  expected ${ej}\n  actual   ${aj}`);
    }
    if (e.autoincrement !== a.autoincrement)
      out.push(`table ${n}: AUTOINCREMENT expected ${e.autoincrement}, actual ${a.autoincrement}`);
  }
  for (const kind of ["views", "triggers"] as const) {
    const keys = [
      ...new Set([...Object.keys(expected[kind]), ...Object.keys(actual[kind])]),
    ].sort();
    for (const k of keys) {
      if (expected[kind][k] !== actual[kind][k])
        out.push(
          `${kind} ${k}: expected ${expected[kind][k] ?? "(none)"}, actual ${actual[kind][k] ?? "(none)"}`,
        );
    }
  }
  return out;
}
