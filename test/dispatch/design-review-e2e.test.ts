import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { listOpenByTicket } from "../../src/db/repos/review-finding.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-dre-"));
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-drewt-")),
  });
}

const sidecar = (json: string) => `Reviewed the plan.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

const cleanPlanFindings = sidecar(JSON.stringify({ findings: [] }));

const blockingPlanFinding = sidecar(
  JSON.stringify({
    findings: [
      {
        severity: "critical",
        category: "feasibility",
        location: "plan:Task 1",
        rationale: "the approach is not feasible",
        factors: null,
        deferral_candidate: false,
        work_unit_seq: null,
      },
    ],
  }),
);

/** Seed the ticket at stage='design', track='full', with design:dispatch+extract already
 *  succeeded and 2 work units, so the resolver routes to design:review. */
function readyForDesignReview(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const dispatch = insertPending(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
  });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(dispatch.id);

  const extract = insertPending(db, {
    ticketId,
    stepKey: "design:extract",
    stepType: "dispatch",
  });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(extract.id);

  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });

  setTicketTrack(db, ticketId, "full");
}

/** Seed a prior 'design' loopback event with the given signature so that the next identical
 *  blocking plan-review round triggers the no-progress escalation path. */
function seedDesignLoopbackEvent(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  signature: string,
) {
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "review",
    signature,
  });
}

// ─── Flow 1: Full-track, clean plan → advances to implement ──────────────────

test("full-track clean plan (no findings) advances ticket from design to implement with no review_finding rows", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForDesignReview(db, ticketId);

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: cleanPlanFindings,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryFor(repo, runner);

  // Drive advanceOneStep until the design:review step fires (clean verdict → "stepped").
  // Then call once more to trigger the inline advance design→implement (the resolver now sees
  // design:dispatch done, units present, track=full, design:review done → emits advance).
  for (let i = 0; i < 10; i++) {
    const t = getTicket(db, ticketId);
    if (!t || t.stage !== "design") break;
    const outcome = await advanceOneStep(db, ticketId, registry);
    if (outcome.kind === "stepped" && "stepKey" in outcome && outcome.stepKey === "design:review") {
      // design:review done clean → fire the inline advance design→implement.
      // The implement stage then dispatches implement:wu1:dispatch which has no real worktree;
      // we catch that throw since the binding fact (stage=implement) is already set inline.
      try {
        await advanceOneStep(db, ticketId, registry);
      } catch {
        // Expected: advance fires (sets stage=implement), then implement:dispatch may throw.
      }
      break;
    }
  }

  const ticket = getTicket(db, ticketId);
  const openFindings = listOpenByTicket(db, ticketId);
  db.close();

  // Binding facts:
  // 1. Ticket advances design → implement (clean verdict + inline advance).
  expect(ticket?.stage).toBe("implement");
  // 2. No review_finding rows exist (0 findings filed).
  expect(openFindings.length).toBe(0);
});

// ─── Flow 2: Full-track, blocking plan finding → re-design ───────────────────

test("blocking plan finding loops back to design: stage=design, work_units cleared, design:review reset to pending", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForDesignReview(db, ticketId);

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: blockingPlanFinding,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryFor(repo, runner);

  // Drive until design:review fires and its verdict routes back.
  const outcome = await advanceOneStep(db, ticketId, registry);

  // Binding facts:
  // 1. advanceOneStep returns loopback.
  expect(outcome.kind).toBe("loopback");

  const ticket = getTicket(db, ticketId);
  // 2. Stage returns to 'design'.
  expect(ticket?.stage).toBe("design");

  // 3. Work units were cleared (redesignLoopback deletes them).
  const units = listUnits(db, ticketId);
  expect(units.length).toBe(0);

  // 4. The design:review step was reset to pending (so it can be re-run in the re-design round).
  const reviewStep = getByKey(db, ticketId, "design:review");
  expect(reviewStep?.status).toBe("pending");

  db.close();
});

// ─── Flow 3: Repeated identical blocking plan round → escalate ────────────────

test("repeated identical blocking plan finding escalates ticket to waiting with human_resume signal pending", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForDesignReview(db, ticketId);

  // The signature that the blocking finding will produce:
  // findingsSignature = "review:feasibility:plan:Task 1" (category:location, sorted)
  // We seed a prior 'design' loopback with this exact signature so isRepeatedReviewLoopback returns true.
  const priorSignature = "review:feasibility:plan:Task 1";
  seedDesignLoopbackEvent(db, ticketId, priorSignature);

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: blockingPlanFinding,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryFor(repo, runner);

  const outcome = await advanceOneStep(db, ticketId, registry);

  // Binding facts:
  // 1. advanceOneStep returns escalated (no-progress detection fires).
  expect(outcome.kind).toBe("escalated");

  const ticket = getTicket(db, ticketId);
  // 2. Ticket status is 'waiting'.
  expect(ticket?.status).toBe("waiting");

  // 3. A human_resume signal is pending.
  const signals = listPending(db, ticketId);
  expect(signals.some((s) => s.signal_type === "human_resume")).toBe(true);

  db.close();
});

// ─── Flow 4: Fast-track ticket SKIPS design:review ───────────────────────────

test("fast-track ticket (1 unit, track=fast) advances design→implement WITHOUT ever creating design:review step", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);

  // Seed only design:dispatch as succeeded (mirroring readyForExtract pattern from
  // design-extract.test.ts). track is intentionally left NULL so the real sizer decides.
  const dispatch = insertPending(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
  });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(dispatch.id);
  // design:extract NOT pre-seeded; work units NOT pre-inserted; track NOT pre-set.
  // The real design:extract handler will run, parse the sidecar, call sizeTrack([1 unit]) = 'fast'.

  // Wire a FakeAgentRunner that:
  //   - On the FIRST call (design:extract): returns a valid 1-unit extract sidecar.
  //   - On any subsequent call (design:review would be one): throws loudly.
  // This enforces that design:review is never dispatched AND pins the sizer's output.
  let callCount = 0;
  const extractSidecarPayload = JSON.stringify({
    units: [
      {
        seq: 1,
        kind: "backend",
        title: "implement the feature",
        description: "add the core backend logic",
        behavioral: false,
        test_plan: null,
        files_to_touch: ["src/feature.ts"],
        verify_check_types: ["build"],
        depends_on: [],
      },
    ],
  });
  const runner = new FakeAgentRunner(() => {
    callCount += 1;
    if (callCount === 1) {
      // Serve the design:extract call with a valid 1-unit sidecar.
      return {
        completed: true,
        exitCode: 0,
        stdout: `Here is the breakdown.\n\n\`\`\`styre-sidecar\n${extractSidecarPayload}\n\`\`\`\n`,
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    // Any second call would be design:review (or implement:dispatch) — both mean the
    // fast-track skip failed. Throw so the test fails loudly.
    throw new Error(
      `unexpected runner call #${callCount}: fast-track ticket must not invoke design:review`,
    );
  });
  const registry = registryFor(repo, runner);

  // Drive the loop until the ticket leaves the design stage:
  //   Tick 1 → design:extract runs (real handler), inserts the 1 unit; track stays null
  //             (extract no longer sizes).
  //   Tick 2 → design:size runs (off path, no agent call) → sizer sees 1 unit → sets track='fast'.
  //   Tick 3 → resolver: design:dispatch done ✓, units present ✓, track='fast' (≠'full') →
  //             advance design→implement (inline, no agent call) → routes to implement:wu1:dispatch
  //             which calls the runner a 2nd time → throws → caught → step fails; the binding fact
  //             (stage=implement) is already committed by the inline advance.
  for (let i = 0; i < 10; i++) {
    const t = getTicket(db, ticketId);
    if (!t || t.stage !== "design") break;
    try {
      await advanceOneStep(db, ticketId, registry);
    } catch {
      // Expected once the inline advance fires: implement:dispatch has no real worktree and
      // throws. The stage transition to implement is already recorded before the runner is called.
    }
  }

  const ticket = getTicket(db, ticketId);
  const designReviewStep = getByKey(db, ticketId, "design:review");
  db.close();

  // Binding facts:
  // 1. The real sizer ran and produced 'fast' from a 1-unit breakdown.
  //    (If the sizer threshold were wrong this would be 'full' and all subsequent asserts would fail.)
  expect(ticket?.track).toBe("fast");
  // 2. Ticket advanced past design (now 'implement') — the inline advance fired.
  expect(ticket?.stage).toBe("implement");
  // 3. design:review step was NEVER created (null = resolver never routed there).
  expect(designReviewStep).toBeNull();
});
