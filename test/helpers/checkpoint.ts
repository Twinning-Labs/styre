import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";

/** Build <root>/<slug>/<ident>/run.db with a single ticket, shaped by `shape`. Returns the dir. */
export function seedCheckpoint(
  root: string,
  slug: string,
  ident: string,
  shape: (db: Database, ticketId: number) => void,
): string {
  const dir = join(root, slug, ident);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "run.db");
  migrate(dbPath);
  const db = openDb(dbPath);
  const projectId = insertProject(db, { slug, targetRepo: "/tmp/x", defaultBranch: "main" });
  const ticketId = insertTicket(db, { projectId, ident, title: ident });
  shape(db, ticketId);
  db.close();
  return dir;
}
