import type { Database } from "bun:sqlite";
import { stripSqlComments } from "../schema-shape.ts";

export interface RebuildSpec {
  table: string;
  /** `CREATE TABLE <table> (...)` with the new definition. */
  createSql: string;
  /** The columns copied from the old table (all must exist in both). */
  columns: readonly string[];
  /** The table's indexes, recreated after the rename. */
  indexes: readonly string[];
}

/** SQLite's documented procedure for a schema change ALTER TABLE cannot make ("Making Other Kinds Of
 *  Table Schema Changes", sqlite.org/lang_altertable.html, spec §7.2): create the new table, copy
 *  the rows, drop the old table, rename, recreate its indexes, and drop and recreate the views and
 *  triggers that name it. Foreign keys must already be off (outside the transaction, where the
 *  pragma is not a no op), and the caller's transaction must be open. */
export function rebuildTable(db: Database, spec: RebuildSpec): void {
  const fk = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  if (fk?.foreign_keys !== 0)
    throw new Error(`rebuildTable(${spec.table}): foreign keys must be off`);
  if (!db.inTransaction)
    throw new Error(`rebuildTable(${spec.table}): must run inside a transaction`);
  const own = db
    .query<{ sql: string | null }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(spec.table);
  // The rebuild does not carry sqlite_sequence over: an AUTOINCREMENT table would lose its high
  // water mark, and ids it had handed out could be handed out again.
  if (/\bAUTOINCREMENT\b/i.test(stripSqlComments(own?.sql ?? "")))
    throw new Error(`rebuildTable(${spec.table}): an AUTOINCREMENT table cannot be rebuilt here`);
  const head = new RegExp(`^\\s*CREATE TABLE ${spec.table}\\b`);
  if (!head.test(spec.createSql))
    throw new Error(`rebuildTable: createSql must start with CREATE TABLE ${spec.table}`);
  const tmp = `${spec.table}__rebuild`;
  // SQLite names are case insensitive: a view may write SIGNAL for signal.
  const mentions = new RegExp(`\\b${spec.table}\\b`, "i");
  const dependents = db
    .query<{ type: string; name: string; sql: string }, []>(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('view','trigger') AND sql IS NOT NULL ORDER BY type DESC, name",
    )
    .all()
    .filter((d) => mentions.test(d.sql));
  for (const d of dependents) db.exec(`DROP ${d.type === "view" ? "VIEW" : "TRIGGER"} ${d.name}`);
  db.exec(spec.createSql.replace(head, `CREATE TABLE ${tmp}`));
  const cols = spec.columns.join(", ");
  db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${spec.table}`);
  db.exec(`DROP TABLE ${spec.table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${spec.table}`);
  for (const ix of spec.indexes) db.exec(ix);
  for (const d of dependents) db.exec(d.sql);
}
