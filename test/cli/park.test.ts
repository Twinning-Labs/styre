import { afterEach, expect, test } from "bun:test";

// Several cases assert on process.exitCode (a global); reset it so a set value
// can't leak into a later test file under a different run ordering.
afterEach(() => {
  process.exitCode = 0;
});
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishRunResult,
  parkDir,
  resetProvisionForResume,
  resumeRun,
} from "../../src/cli/park.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

// helper: journal a step straight to succeeded (mirrors resolver.test.ts's local `succeed`,
// which is not shared/importable — see plan Task 7 review F5). `effectful: true` matches how
// real dispatches run (advance.ts always sets it), so `attempt` is incremented like production.
async function succeed(db: Parameters<typeof runStep>[0], ticketId: number, stepKey: string) {
  await runStep(db, {
    ticketId,
    stepKey,
    stepType: "provision",
    effectful: true,
    execute: () => ({ ok: true }),
  });
}

test("finishRunResult does not throw for blocked; sets exit 1 and closes db", () => {
  const { db, ticketId } = makeTestDb();
  process.exitCode = 0;
  expect(() =>
    finishRunResult(db, "/tmp/does-not-matter.db", "test-project", "ENG-1", {
      outcome: "blocked",
    }),
  ).not.toThrow();
  expect(process.exitCode).toBe(1);
  expect(() => db.query("SELECT 1").get()).toThrow(); // closed db throws on use
  void ticketId;
});

test("resetProvisionForResume flips a succeeded provision step back to pending with attempt 0", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "provision");
  const before = getByKey(db, ticketId, "provision");
  expect(before?.status).toBe("succeeded");
  expect(before?.attempt).toBeGreaterThan(0);

  resetProvisionForResume(db, ticketId);

  const after = getByKey(db, ticketId, "provision");
  db.close();
  expect(after?.status).toBe("pending");
  expect(after?.attempt).toBe(0);
});

test("resetProvisionForResume is a no-op when there is no provision step yet", () => {
  const { db, ticketId } = makeTestDb();
  resetProvisionForResume(db, ticketId); // must not throw
  const after = getByKey(db, ticketId, "provision");
  db.close();
  expect(after).toBeNull();
});

test("resetProvisionForResume is a no-op when provision is still pending/running (not succeeded)", async () => {
  const { db, ticketId } = makeTestDb();
  const run = runStep(db, {
    ticketId,
    stepKey: "provision",
    stepType: "provision",
    execute: () => {
      throw new Error("boom");
    },
  });
  await expect(run).rejects.toThrow("boom");

  resetProvisionForResume(db, ticketId);

  const after = getByKey(db, ticketId, "provision");
  db.close();
  expect(after?.status).toBe("failed"); // untouched: resetProvisionForResume only resets 'succeeded'
});

/** Build a real temp git repo with an initial commit (mirrors helpers/git-project.ts's private
 *  `gitRepo`, which isn't exported). Only needed so `resumeRun`'s `branchHeadSha` git calls have
 *  a real repo to run against; the ticket's feature branch itself need not exist. */
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-park-wire-repo-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("resumeRun wires resetProvisionForResume into the resume path (S4)", async () => {
  // Build a parked-run dump on disk (the shape `resumeRun` reads: <XDG_STATE_HOME>/styre/<slug>/<ident>/run.db),
  // with a `provision` step already 'succeeded' — simulating a prior attempt that installed deps
  // into a worktree which has since been wiped. `resumeRun` must reset it to 'pending' as part of
  // its resume prep, BEFORE it ever dispatches another step.
  const stateRoot = mkdtempSync(join(tmpdir(), "styre-park-wire-state-"));
  const prevXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  const repoPath = gitRepo();
  const slug = "wire-test";
  const ident = "ENG-9";

  try {
    const dir = parkDir(slug, ident);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "run.db");
    migrate(dbPath);
    const seedDb = openDb(dbPath);
    const projectId = insertProject(seedDb, { slug, targetRepo: repoPath });
    const ticketId = insertTicket(seedDb, { projectId, ident });
    setTicketStage(seedDb, ticketId, "implement");
    await runStep(seedDb, {
      ticketId,
      stepKey: "provision",
      stepType: "provision",
      effectful: true,
      execute: () => ({ ok: true }),
    });
    expect(getByKey(seedDb, ticketId, "provision")?.status).toBe("succeeded");
    seedDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    seedDb.close();

    const profile = parseProfile({
      slug,
      targetRepo: repoPath,
      defaultBranch: "main",
      checksSystem: "none",
    });

    // A sentinel thrown from buildRegistry stops resumeRun right after its resume-prep (cleanup +
    // resetProvisionForResume + recover) and before any step is actually dispatched — exactly the
    // window this test needs to observe.
    class Sentinel extends Error {}
    let observedStatus: string | undefined;
    await expect(
      resumeRun({ resume: ident }, profile, DEFAULT_RUNTIME_CONFIG, {
        ports: {
          issueTracker: fakeIssueTracker({
            ticket: {
              ident,
              title: "Wire test",
              description: "body",
              typeLabel: "Feature",
              externalId: "uuid-wire",
              url: null,
            },
          }),
          forge: fakeForge(),
          checks: fakeChecks("passing"),
        },
        buildRegistry: () => {
          const checkDb = openDb(dbPath);
          observedStatus = getByKey(checkDb, ticketId, "provision")?.status;
          checkDb.close();
          throw new Sentinel("stop before dispatch");
        },
      }),
    ).rejects.toThrow("stop before dispatch");

    expect(observedStatus).toBe("pending");
  } finally {
    if (prevXdgStateHome === undefined) {
      process.env.XDG_STATE_HOME = undefined;
    } else {
      process.env.XDG_STATE_HOME = prevXdgStateHome;
    }
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});
