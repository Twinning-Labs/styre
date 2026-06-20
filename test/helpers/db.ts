import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";

/** Migrate a fresh tmp DB, open it, and seed one project + one ticket.
 *  The caller is responsible for db.close(). */
export function makeTestDb(): { db: Database; projectId: number; ticketId: number } {
  const path = join(mkdtempSync(join(tmpdir(), "styre-m1-")), "styre.db");
  migrate(path);
  const db = openDb(path);
  const projectId = insertProject(db, { slug: "test-project", targetRepo: "/tmp/repo" });
  const ticketId = insertTicket(db, { projectId, ident: "ENG-1" });
  return { db, projectId, ticketId };
}
