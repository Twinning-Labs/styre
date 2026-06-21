import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listOpenByTicket } from "../../src/db/repos/review-finding.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-re-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function registryFor(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "bun test" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-rewt-")),
  });
}

const sidecar = (json: string) => `Reviewed.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

const cleanFindings = sidecar(JSON.stringify({ findings: [] }));

const blockingCodeFinding = sidecar(
  JSON.stringify({
    findings: [
      {
        severity: "major",
        category: "correctness",
        location: "src/a.ts:10",
        rationale: "null dereference",
        factors: null,
        deferral_candidate: false,
        work_unit_seq: 1,
      },
    ],
  }),
);

const planDefectFinding = sidecar(
  JSON.stringify({
    findings: [
      {
        severity: "critical",
        category: "plan-defect",
        location: null,
        rationale: "design flaw",
        factors: null,
        deferral_candidate: false,
        work_unit_seq: null,
      },
    ],
  }),
);

const deferralFinding = sidecar(
  JSON.stringify({
    findings: [
      {
        severity: "major",
        category: "maintainability",
        location: "src/b.ts:5",
        rationale: "could be cleaner but not blocking",
        factors: null,
        deferral_candidate: true,
        work_unit_seq: null,
      },
    ],
  }),
);

/** Seed the ticket at stage='review' with one verified work unit.
 *  This lets the e2e tests focus on review verdict routing without
 *  re-testing the whole design→implement→verify pipeline. */
function readyForReview(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    status: "verified",
  });
}

// ─── Flow 1: Clean review → merge ────────────────────────────────────────────

test("clean review (no findings) advances ticket to merge with no review_finding rows", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForReview(db, ticketId);

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: cleanFindings,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryFor(repo, runner);

  // Drive until the review step is done. The subsequent advanceOneStep call advances stage
  // to 'merge' inline then throws because merge:push has no handler in this test registry.
  // We catch that throw to assert stage=merge without needing a full merge pipeline.
  for (let i = 0; i < 8; i++) {
    const t = getTicket(db, ticketId);
    if (!t || t.stage !== "review") break;
    const outcome = await advanceOneStep(db, ticketId, registry);
    if (outcome.kind === "stepped" && "stepKey" in outcome && outcome.stepKey === "review") {
      // Review step done — call once more to trigger the inline advance to 'merge'.
      try {
        await advanceOneStep(db, ticketId, registry);
      } catch {
        // Expected: advance fires (sets stage=merge), then merge:push has no handler.
      }
      break;
    }
  }

  const ticket = getTicket(db, ticketId);
  const openFindings = listOpenByTicket(db, ticketId);
  db.close();

  expect(ticket?.stage).toBe("merge");
  expect(openFindings.length).toBe(0);
});

// ─── Flow 2: Blocking code finding → re-code → clean → merge ─────────────────

test("blocking code finding loops back to implement; clean second review drives to merge with first finding superseded", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForReview(db, ticketId);

  // Track review attempts: round 1 → blocking finding, round 2 → clean.
  let reviewAttempt = 0;
  const runner = new FakeAgentRunner(() => {
    reviewAttempt += 1;
    return {
      completed: true,
      exitCode: 0,
      stdout: reviewAttempt === 1 ? blockingCodeFinding : cleanFindings,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry = registryFor(repo, runner);

  // Round 1: drive until the review handler fires and routes back to implement.
  const outcome = await advanceOneStep(db, ticketId, registry);
  expect(outcome.kind).toBe("loopback");

  // After loopback: stage is implement, review step is pending.
  expect(getTicket(db, ticketId)?.stage).toBe("implement");
  const reviewStepAfterLoopback = getByKey(db, ticketId, "review");
  expect(reviewStepAfterLoopback?.status).toBe("pending");

  // The round-1 finding should now be superseded (not open).
  const openAfterLoopback = listOpenByTicket(db, ticketId);
  expect(openAfterLoopback.length).toBe(0); // blocking finding is now superseded

  // Verify all round-1 findings are superseded via direct query.
  const allRound1 = db
    .query<{ status: string }, [number]>(
      "SELECT status FROM review_finding WHERE ticket_id = ? ORDER BY id",
    )
    .all(ticketId);
  expect(allRound1.every((r) => r.status === "superseded")).toBe(true);

  // Re-seed the ticket at review stage (simulate re-coding + verify completing).
  // This keeps the test focused on the review verdict route without re-testing implement/verify.
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  db.query("UPDATE work_unit SET status = 'verified' WHERE ticket_id = ?").run(ticketId);

  // Round 2: drive the review step with clean findings, then catch the merge:push throw.
  for (let i = 0; i < 8; i++) {
    const t = getTicket(db, ticketId);
    if (!t || t.stage !== "review") break;
    const stepOutcome = await advanceOneStep(db, ticketId, registry);
    if (
      stepOutcome.kind === "stepped" &&
      "stepKey" in stepOutcome &&
      stepOutcome.stepKey === "review"
    ) {
      try {
        await advanceOneStep(db, ticketId, registry);
      } catch {
        // Expected: advance fires inline (stage→merge), then merge:push has no handler.
      }
      break;
    }
  }

  expect(getTicket(db, ticketId)?.stage).toBe("merge");

  // Round-2 findings: no open ones (clean review).
  const openAfterMerge = listOpenByTicket(db, ticketId);
  expect(openAfterMerge.length).toBe(0);

  // Total finding count: 1 superseded (round 1), 0 from round 2 (clean).
  const allFindings = db
    .query<{ status: string }, [number]>(
      "SELECT status FROM review_finding WHERE ticket_id = ? ORDER BY id",
    )
    .all(ticketId);
  expect(allFindings.length).toBe(1);
  expect(allFindings[0]?.status).toBe("superseded");

  db.close();
});

// ─── Flow 3: Plan-defect, default config (escalate) → parked ─────────────────

test("blocking plan-defect with default config escalates ticket to waiting with human_resume pending", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForReview(db, ticketId);

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: planDefectFinding,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryFor(repo, runner);

  // Default config: onPlanDefect = "escalate".
  const outcome = await advanceOneStep(db, ticketId, registry);
  expect(outcome.kind).toBe("escalated");

  const ticket = getTicket(db, ticketId);
  expect(ticket?.status).toBe("waiting");

  const signals = listPending(db, ticketId);
  expect(signals.some((s) => s.signal_type === "human_resume")).toBe(true);

  db.close();
});

// ─── Flow 4: Plan-defect, config redesign → back to design ───────────────────

test("blocking plan-defect with onPlanDefect=redesign routes to design stage with work_units cleared", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForReview(db, ticketId);

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: planDefectFinding,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryFor(repo, runner);

  // Pass config with redesign policy.
  const outcome = await advanceOneStep(db, ticketId, registry, {
    config: { onPlanDefect: "redesign" },
  });
  expect(outcome.kind).toBe("loopback");

  const ticket = getTicket(db, ticketId);
  expect(ticket?.stage).toBe("design");

  const units = listUnits(db, ticketId);
  expect(units.length).toBe(0);

  db.close();
});

// ─── Flow 5: Major + deferral_candidate → escalated ─────────────────────────

test("major finding with deferral_candidate=true escalates ticket to waiting with human_resume pending", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForReview(db, ticketId);

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: deferralFinding,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryFor(repo, runner);

  const outcome = await advanceOneStep(db, ticketId, registry);
  expect(outcome.kind).toBe("escalated");

  const ticket = getTicket(db, ticketId);
  expect(ticket?.status).toBe("waiting");

  const signals = listPending(db, ticketId);
  expect(signals.some((s) => s.signal_type === "human_resume")).toBe(true);

  // The finding stays 'open': the deferral path escalates the ticket to waiting for a human
  // deferral decision but does NOT supersede the finding (that decision belongs to the operator).
  const open = listOpenByTicket(db, ticketId);
  expect(open.length).toBe(1);
  expect(open[0]?.blocks_ship).toBe(0);
  expect(open[0]?.deferral_candidate).toBe(1);

  db.close();
});
