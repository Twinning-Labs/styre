// scripts/db-fixtures/seed-era.ts
// Usage: bun scripts/db-fixtures/seed-era.ts <eraRoot> <out.db> <bridge|plain>
// Creates <out.db> with the release checked out at <eraRoot>: that release's own migrate() and
// schema.sql, and rows written through that release's own repositories (spec §7.5). The rows cover
// what the migrations and the readers that do not migrate must handle: succeeded design steps, a
// reconcile unit, a step waiting on a signal (the incoming foreign key the v7 -> v8 `signal`
// rebuild must keep), and an interrupted in-place step with its interruption note (what `--fresh`
// and `clean` read).
import type { Database } from "bun:sqlite";
import { join } from "node:path";

const [eraRoot, out, mode] = process.argv.slice(2);
if (!eraRoot || !out || (mode !== "bridge" && mode !== "plain")) {
  throw new Error("usage: seed-era.ts <eraRoot> <out.db> <bridge|plain>");
}
// Bounded on its own, so nothing outlives a generator that was stopped (its limit is 60 s).
setTimeout(() => {
  process.stderr.write("seed-era: time limit reached\n");
  process.exit(3);
}, 50_000).unref();
const era = (p: string) => import(join(eraRoot, p));

// Verbatim from b3be1be:src/db/repos/run.ts (ensureRunTable), the resume bridge v0.11+ applied to
// v7 checkpoints without bumping their version.
const BRIDGE_DDL = `CREATE TABLE IF NOT EXISTS run (
       id          INTEGER PRIMARY KEY,
       run_id      TEXT    NOT NULL,
       started_at  TEXT    NOT NULL,
       provider    TEXT    NOT NULL,
       resumed     INTEGER NOT NULL DEFAULT 0 CHECK (resumed IN (0,1)),
       attempt     INTEGER NOT NULL DEFAULT 1
     )`;

const { migrate } = await era("src/db/migrate.ts");
const { openDb } = await era("src/db/client.ts");
const projects = await era("src/db/repos/project.ts");
const tickets = await era("src/db/repos/ticket.ts");

migrate(out);
const db: Database = openDb(out);
const version = db.query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_meta").get()?.v;
if (version === undefined) throw new Error(`${out}: no schema_meta row`);

const projectId = projects.insertProject(db, {
  slug: "fixture",
  targetRepo: "/nonexistent/styre-fixture-repo",
  defaultBranch: "main",
});
const ticketId = tickets.insertTicket(db, {
  projectId,
  ident: "ENG-1",
  title: "Fixture ticket",
  description: "Fixture body",
  typeLabel: "Feature",
  branchPrefix: "feat",
});

if (version >= 7) {
  const steps = await era("src/db/repos/workflow-step.ts");
  const units = await era("src/db/repos/work-unit.ts");
  const signals = await era("src/db/repos/signal.ts");
  const dispatches = await era("src/db/repos/dispatch.ts");
  const events = await era("src/db/repos/event-log.ts");
  for (const [stepKey, stepType] of [
    ["provision", "provision"],
    ["design:dispatch", "dispatch"],
    ["design:extract", "dispatch"],
    ["design:size", "dispatch"],
  ]) {
    const s = steps.insertPending(db, { ticketId, stepKey, stepType });
    steps.markSucceeded(db, s.id, { fixture: stepKey });
  }
  const u1 = units.insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    title: "Unit one",
    description: "Do the thing",
    behavioral: 0,
    testPlan: null,
    filesToTouch: ["src/a.ts"],
    verifyCheckTypes: [],
    dependsOn: [],
  });
  units.insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "reconcile",
    behavioral: 0,
    verifyCheckTypes: [],
    dependsOn: [1],
  });
  tickets.setTicketTrack(db, ticketId, "fast");
  tickets.setTicketStage(db, ticketId, "implement");
  const signal = signals.insertPending(db, {
    ticketId,
    signalType: "human_resume",
    reason: "fixture pause",
  });
  db.query(
    "UPDATE workflow_step SET await_signal_id = ? WHERE ticket_id = ? AND step_key = 'design:size'",
  ).run(signal.id, ticketId);
  const running = steps.insertPending(db, {
    ticketId,
    workUnitId: u1.id,
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
  });
  steps.markRunning(db, running.id, {});
  const startedAt = steps.getById(db, running.id).started_at;
  dispatches.insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: 1,
    workUnitId: u1.id,
    stepId: running.id,
    stage: "implement",
    model: "fixture-model",
    startedAt,
    worktreePath: "/nonexistent/styre-fixture-repo",
  });
  events.appendEvent(db, {
    ticketId,
    kind: "note",
    reason: "interrupted",
    payload: {
      event: "interrupted",
      stepId: running.id,
      attempt: 1,
      startedAt,
      signal: "SIGTERM",
      worktree: "/nonexistent/styre-fixture-repo",
      untrackedBefore: [],
      dispatchRowId: null,
      headAtStart: null,
      headAtStop: null,
    },
  });
}
if (mode === "bridge") db.exec(BRIDGE_DDL);
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
db.close();
