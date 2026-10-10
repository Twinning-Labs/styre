import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertRun } from "../../src/db/repos/run.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { nowUtc } from "../../src/util/time.ts";
import { makeTempDir } from "./temp.ts";

/** The profile every makeTestDb ticket's snapshot is captured from (the tests that use makeTestDb
 *  build their own registries; the snapshot only has to exist and stay stable). */
export const TEST_PROFILE = parseProfile({
  slug: "test-project",
  targetRepo: "/tmp/repo",
  components: [],
});

/** Migrate a fresh tmp DB, open it, and seed one project + one ticket + one run.
 *  `provider` sets the run row's provider (default "claude"). Caller must db.close(). The
 *  folder is removed for the caller (test/helpers/temp.ts). */
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
  const path = join(makeTempDir("styre-m1-"), "styre.db");
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
    captureSnapshot(db, ticketId, {
      profile: TEST_PROFILE,
      unusableComponents: [],
      nonPrimaryComponents: [],
      config: DEFAULT_RUNTIME_CONFIG,
    });
    return { db, projectId, ticketId };
  }
  return { db, projectId: undefined, ticketId: undefined };
}
