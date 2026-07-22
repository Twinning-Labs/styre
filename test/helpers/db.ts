import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertRun } from "../../src/db/repos/run.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import { nowUtc } from "../../src/util/time.ts";

/** Migrate a fresh tmp DB, open it, and seed one project + one ticket + one run.
 *  `provider` sets the run row's provider (default "claude"). Caller must db.close(). */
export function makeTestDb(opts?: { provider?: string }): {
  db: Database;
  projectId: number;
  ticketId: number;
};
/** Migrate a fresh tmp DB without seeding any rows. The caller is responsible for db.close(). */
export function makeTestDb(opts: { seedTicket: false }): {
  db: Database;
  projectId: undefined;
  ticketId: undefined;
};
export function makeTestDb(opts?: { seedTicket?: boolean; provider?: string }): {
  db: Database;
  projectId: number | undefined;
  ticketId: number | undefined;
} {
  const seedTicket = opts?.seedTicket !== false;
  const path = join(mkdtempSync(join(tmpdir(), "styre-m1-")), "styre.db");
  migrate(path);
  const db = openDb(path);
  if (seedTicket) {
    const projectId = insertProject(db, { slug: "test-project", targetRepo: "/tmp/repo" });
    const ticketId = insertTicket(db, { projectId, ident: "ENG-1" });
    insertRun(db, {
      runId: "test-run-0001",
      startedAt: nowUtc(),
      provider: opts?.provider ?? "claude",
    });
    return { db, projectId, ticketId };
  }
  return { db, projectId: undefined, ticketId: undefined };
}
