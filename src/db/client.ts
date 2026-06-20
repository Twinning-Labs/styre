import { Database } from "bun:sqlite";

/** Open the SoT DB with the daemon's required PRAGMAs (control-loop §2.2). */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}
