import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { makeTestDb } from "./db.ts";

/** Build a real temp git repo with an initial commit. Returns the repo root path. */
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-gp-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

/** Create a fresh test DB seeded with:
 *  - a real git repo pointed to by project.target_repo
 *  - ticket ENG-1 at stage='implement'
 *  - one pending work_unit (seq=1, kind='backend') so the resolver dispatches 'implement:dispatch'
 *
 * Returns the db and the ticketId. The caller is responsible for db.close(). */
export function gitRepoWithProject(): {
  db: ReturnType<typeof makeTestDb>["db"];
  ticketId: number;
  projectId: number;
  repoPath: string;
} {
  const repoPath = gitRepo();
  const { db, projectId, ticketId } = makeTestDb();

  // Point the seeded project at the real git repo
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repoPath, projectId);

  // Advance the ticket to the 'implement' stage
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);

  // Insert one pending work_unit so nextStepKey returns implement:wu1:dispatch
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: [],
  });

  return { db, ticketId, projectId, repoPath };
}
