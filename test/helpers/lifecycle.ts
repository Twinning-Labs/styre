// Fixtures for the interruption tests (ENG-485 section 7.5): a run database holding one ticket whose
// step is `running`, and the same database pointed at a real git repository.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectorPorts } from "../../src/daemon/projector.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { completeDispatch, insertDispatch } from "../../src/db/repos/dispatch.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { enqueue } from "../../src/db/repos/projection-outbox.ts";
import { insertRun } from "../../src/db/repos/run.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import * as steps from "../../src/db/repos/workflow-step.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { nowUtc } from "../../src/util/time.ts";

export interface TicketDb {
  path: string;
  ticketId: number;
  stepId: number;
  startedAt: string;
  dispatchRowId: number;
  /** A dispatch row of the same step from its FIRST attempt, started before the current one. */
  earlierDispatchRowId: number;
}

/** A migrated file database with one ticket and one `running` step at attempt 2 (the given
 *  `stepKey`, default `implement:dispatch`), an earlier dispatch row from attempt 1, and an open
 *  dispatch row for attempt 2. A `verify:*` key gets step type `verify`; use `verify:integration`
 *  for a suite step. `pid` sets the journaled pid (only an older Styre wrote one). The database is
 *  closed on return. */
export function makeTicketDb(opts?: {
  stepKey?: string;
  pid?: number;
  targetRepo?: string;
  worktreePath?: string;
  /** Where to create the database (default: a new temporary folder). */
  path?: string;
}): TicketDb {
  const path = opts?.path ?? join(mkdtempSync(join(tmpdir(), "styre-lifecycle-")), "run.db");
  mkdirSync(dirname(path), { recursive: true });
  migrate(path);
  const db = openDb(path);
  try {
    const projectId = insertProject(db, {
      slug: "test-project",
      targetRepo: opts?.targetRepo ?? "/tmp/repo",
    });
    const ticketId = insertTicket(db, { projectId, ident: "ENG-1" });
    insertRun(db, { runId: "test-run-0001", startedAt: nowUtc(), provider: "claude" });
    const stepKey = opts?.stepKey ?? "implement:dispatch";
    const step = steps.insertPending(db, {
      ticketId,
      stepKey,
      stepType: stepKey.startsWith("verify:") ? "verify" : "dispatch",
    });
    // Attempt 1, with its own dispatch row, then attempt 2 strictly later.
    steps.markRunning(db, step.id, {});
    const first = steps.getById(db, step.id)?.started_at as string;
    const earlier = insertDispatch(db, {
      ticketId,
      dispatchId: "d-1",
      seq: 1,
      stepId: step.id,
      startedAt: first,
      worktreePath: opts?.worktreePath ?? null,
    });
    completeDispatch(db, earlier.id, { outcome: "dispatch-failed", endedAt: nowUtc() });
    Bun.sleepSync(3);
    steps.markRunning(db, step.id, { pid: opts?.pid ?? null });
    const startedAt = steps.getById(db, step.id)?.started_at as string;
    const open = insertDispatch(db, {
      ticketId,
      dispatchId: "d-2",
      seq: 2,
      stepId: step.id,
      startedAt: nowUtc(),
      worktreePath: opts?.worktreePath ?? null,
    });
    return {
      path,
      ticketId,
      stepId: step.id,
      startedAt,
      dispatchRowId: open.id,
      earlierDispatchRowId: earlier.id,
    };
  } finally {
    db.close();
  }
}

export function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

export interface GitProject extends TicketDb {
  repo: string;
  branch: string;
  /** The `main` commit the branch started from. */
  I: string;
  /** Where the step started. */
  A: string;
  /** What the step committed before it was stopped. */
  B: string;
  dbPath: string;
  /** The branch's current commit, read from its ref (works whichever checkout holds it). */
  head(): string;
  /** A commit on the branch by someone other than the step; returns its sha. */
  commitAsOperator(): string;
}

/** A repository on branch `b` with commit A, then commit B made by the step in flight, and the
 *  `makeTicketDb` rows with the open dispatch row completed at `branch_head_sha = B` (the runner's
 *  commit). In place (the default) the checkout stays on `b` and every dispatch row names the
 *  repository as its worktree; in worktree mode the checkout goes back to `main`. */
export function makeGitProject(opts?: { mode?: "in-place" | "worktree" }): GitProject {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "styre-lifecycle-repo-")));
  const branch = "b";
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@s.dev"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "x\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  const I = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-b", branch]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "A"]);
  const A = git(repo, ["rev-parse", "HEAD"]);
  const inPlace = (opts?.mode ?? "in-place") === "in-place";
  const t = makeTicketDb({ targetRepo: repo, worktreePath: inPlace ? repo : `${repo}-wt` });
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "B"]);
  const B = git(repo, ["rev-parse", "HEAD"]);
  if (!inPlace) git(repo, ["checkout", "main"]);
  const db = openDb(t.path);
  // The ticket's branch, as --fresh and clean derive it from the checkpoint.
  db.query("UPDATE ticket SET branch_name = ? WHERE id = ?").run(branch, t.ticketId);
  completeDispatch(db, t.dispatchRowId, {
    outcome: "succeeded",
    branchHeadSha: B,
    endedAt: nowUtc(),
  });
  db.close();
  let n = 0;
  return {
    ...t,
    repo,
    branch,
    I,
    A,
    B,
    dbPath: t.path,
    head: () => git(repo, ["rev-parse", `refs/heads/${branch}`]),
    commitAsOperator: () => {
      n++;
      // In place the checkout is on the branch; in worktree mode commit through a plumbing write
      // so no checkout has to hold the branch.
      if (inPlace) {
        writeFileSync(join(repo, `operator-${n}.txt`), "op\n");
        git(repo, ["add", "-A"]);
        git(repo, ["commit", "-m", `operator ${n}`]);
        return git(repo, ["rev-parse", "HEAD"]);
      }
      const tree = git(repo, ["rev-parse", `refs/heads/${branch}^{tree}`]);
      const sha = git(repo, [
        "commit-tree",
        tree,
        "-p",
        `refs/heads/${branch}`,
        "-m",
        `operator ${n}`,
      ]);
      git(repo, ["update-ref", `refs/heads/${branch}`, sha]);
      return sha;
    },
  };
}

/** A run database with three pending outbox rows (tracker comments) and ports that count the
 *  calls they receive. `onCall` runs inside each call, before it returns (a test can begin a stop
 *  there). The caller closes `db`. */
export function makeOutboxDb(opts?: { onCall?: (n: number) => void }): {
  db: ReturnType<typeof openDb>;
  ticketId: number;
  ports: ProjectorPorts;
  calls(): number;
  pending(): number;
} {
  const path = join(mkdtempSync(join(tmpdir(), "styre-outbox-")), "run.db");
  migrate(path);
  const db = openDb(path);
  const projectId = insertProject(db, { slug: "test-project", targetRepo: "/tmp/repo" });
  const ticketId = insertTicket(db, { projectId, ident: "ENG-1" });
  insertRun(db, { runId: "test-run-0001", startedAt: nowUtc(), provider: "claude" });
  for (const n of [1, 2, 3]) {
    enqueue(db, {
      ticketId,
      target: "issue_tracker",
      op: "add_comment",
      payload: { body: `comment ${n}` },
      idempotencyKey: `k-${n}`,
    });
  }
  const tracker = fakeIssueTracker();
  let n = 0;
  const addComment = tracker.addComment.bind(tracker);
  tracker.addComment = async (ref, body, key) => {
    n++;
    opts?.onCall?.(n);
    return addComment(ref, body, key);
  };
  return {
    db,
    ticketId,
    ports: { issueTracker: tracker },
    calls: () => n,
    pending: () =>
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM projection_outbox WHERE status = 'pending'",
        )
        .get()?.n ?? -1,
  };
}
