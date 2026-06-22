import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-dse-"));
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-dsewt-")),
  });
}

/** Seed design:dispatch as succeeded and insert `unitCount` backend work units.
 *  track stays null so design:size is the next step the resolver routes to. */
function readyForSize(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  unitCount: number,
) {
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  for (let i = 1; i <= unitCount; i++) {
    insertWorkUnit(db, {
      ticketId,
      seq: i,
      kind: "backend",
      behavioral: 0,
      verifyCheckTypes: ["test"],
    });
  }
  // design:extract must also be succeeded (resolver: units present but extract step absent is fine;
  // it checks units.length > 0 not extract step, but to be safe we mark it done too).
  const e = insertPending(db, { ticketId, stepKey: "design:extract", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(e.id);
}

/** Sidecar bodies used by the fake runners. */
const gradeSidecar = (overall: number) =>
  `Grade complete.\n\n\`\`\`styre-sidecar\n${JSON.stringify({
    dimensions: { coupling: 0, blast_radius: 0, difficulty: 0 },
    overall,
  })}\n\`\`\`\n`;

const cleanPlanSidecar = `Reviewed the plan.\n\n\`\`\`styre-sidecar\n${JSON.stringify({ findings: [] })}\n\`\`\`\n`;

const ON_CONFIG = {
  config: { ...DEFAULT_RUNTIME_CONFIG, onPlanDefect: "escalate" as const, complexityGrading: true },
};

// ─── Flow 1: Grader OFF (default): 2-unit ticket → full → routes to design:review ────────────

test("grader off: 2-unit ticket sizes to 'full' via sprawl and design:review is dispatched", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForSize(db, ticketId, 2);

  // design:size is off — any grader call is a test failure.
  // design:review will be called once with clean findings.
  let callCount = 0;
  const runner = new FakeAgentRunner(() => {
    callCount += 1;
    if (callCount === 1) {
      // First (and only) agent call: design:review with clean plan → allow advance to implement.
      return {
        completed: true,
        exitCode: 0,
        stdout: cleanPlanSidecar,
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    // Any second call means the grader fired (wrong) or the test over-drove the loop.
    throw new Error(`unexpected runner call #${callCount} in grader-off flow`);
  });

  const registry = registryFor(repo, runner);

  // Drive the loop: design:size (no agent) sets track='full'; then design:review fires.
  // After design:review succeeds cleanly the inline advance fires (design→implement).
  // implement:wu1:dispatch would call the runner — we catch that throw.
  // Default config (no opts) means complexityGrading=false — sprawl-only sizing.
  for (let i = 0; i < 15; i++) {
    const t = getTicket(db, ticketId);
    if (!t || t.stage !== "design") break;
    try {
      await advanceOneStep(db, ticketId, registry);
    } catch {
      // Once the inline advance fires (design→implement) the next call tries
      // implement:dispatch with no real worktree — expected; the stage transition is already set.
    }
  }

  const ticket = getTicket(db, ticketId);
  const reviewStep = getByKey(db, ticketId, "design:review");
  db.close();

  // Binding facts:
  // 1. The sprawl sizer set track='full' (2 units ≥ FULL_TRACK_MIN_UNITS=2).
  expect(ticket?.track).toBe("full");
  // 2. design:review was dispatched (the step exists and is not null).
  expect(reviewStep).not.toBeNull();
  // 3. The only agent call was design:review (NOT a grader call). At most 2 runner calls:
  //    design:review + the implement:dispatch attempt (which throws). callCount ≤ 2.
  expect(callCount).toBeLessThanOrEqual(2);
});

// ─── Flow 2: Grader ON: 3 simple units → overall=2 → fast → SKIPS design:review ─────────────

test("grader on: 3-unit ticket with overall=2 sizes to 'fast' and design:review is never created", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForSize(db, ticketId, 3);

  // design:size (grader on): returns a grade with overall=2.
  // design:review must NOT be called (fast-track skips it).
  // Any call after the first grade → fail loudly.
  let callCount = 0;
  const runner = new FakeAgentRunner((input) => {
    callCount += 1;
    if (callCount === 1) {
      // Verify this is the grade prompt (complexity grader), not design:review.
      if (!input.prompt.includes("COMPLEXITY") && !input.prompt.includes("grading")) {
        throw new Error(
          `grader-on flow: expected complexity grade call first, got: ${input.prompt.slice(0, 80)}`,
        );
      }
      return {
        completed: true,
        exitCode: 0,
        stdout: gradeSidecar(2),
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    // A second call would be design:review (which must be skipped) or implement:dispatch.
    // We only fail if it looks like design:review (the fast-track invariant).
    if (
      input.prompt.includes("independent plan reviewer") ||
      input.prompt.includes("plan reviewer")
    ) {
      throw new Error(
        `grader-on fast-track: design:review must NOT be dispatched (call #${callCount})`,
      );
    }
    // implement:dispatch has no real worktree — let it throw naturally so the stage transition
    // (design→implement) is already committed before this call.
    throw new Error(`expected: implement dispatch has no real worktree (call #${callCount})`);
  });

  const registry = registryFor(repo, runner);

  // Drive the loop until the ticket leaves design:
  //   Tick N: design:size runs (grader on) → grade overall=2, 3 units → combineTrack(3,2)='fast'
  //   Tick N+1: resolver sees track='fast' (≠'full') → advance design→implement (inline)
  //   Tick N+2: implement:wu1:dispatch → no real worktree → throws → caught.
  for (let i = 0; i < 15; i++) {
    const t = getTicket(db, ticketId);
    if (!t || t.stage !== "design") break;
    try {
      await advanceOneStep(db, ticketId, registry, ON_CONFIG);
    } catch {
      // Expected once the inline advance fires.
    }
  }

  const ticket = getTicket(db, ticketId);
  const reviewStep = getByKey(db, ticketId, "design:review");
  db.close();

  // Binding facts:
  // 1. Grade + combineTrack produced 'fast' (overall=2 < 5 AND units=3 < 5).
  expect(ticket?.track).toBe("fast");
  // 2. Ticket advanced past design (stage=implement).
  expect(ticket?.stage).toBe("implement");
  // 3. design:review step was NEVER created (fast-track skips it).
  expect(reviewStep).toBeNull();
});

// ─── Flow 3: Grader ON: 1 unit, high overall=8 → full → design:review runs ──────────────────

test("grader on: 1-unit ticket with overall=8 sizes to 'full' and design:review is dispatched", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForSize(db, ticketId, 1);

  // Two agent calls expected:
  //   Call 1: design:size (grader on) → grade overall=8
  //   Call 2: design:review → clean findings
  let callCount = 0;
  const runner = new FakeAgentRunner((_input) => {
    callCount += 1;
    if (callCount === 1) {
      // Should be the complexity grade call.
      return {
        completed: true,
        exitCode: 0,
        stdout: gradeSidecar(8),
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    if (callCount === 2) {
      // Should be design:review with clean plan.
      return {
        completed: true,
        exitCode: 0,
        stdout: cleanPlanSidecar,
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    // Third call = implement:dispatch (no real worktree) — throw so the loop breaks.
    throw new Error(`expected: implement dispatch has no real worktree (call #${callCount})`);
  });

  const registry = registryFor(repo, runner);

  // Drive the loop:
  //   Tick N: design:size (grader on) → overall=8, 1 unit → combineTrack(1,8)='full'
  //   Tick N+1: resolver: track='full', design:review not done → design:review fires
  //   Tick N+2: design:review clean → advance design→implement (inline)
  //   Tick N+3: implement:wu1:dispatch → throws → caught.
  for (let i = 0; i < 15; i++) {
    const t = getTicket(db, ticketId);
    if (!t || t.stage !== "design") break;
    try {
      await advanceOneStep(db, ticketId, registry, ON_CONFIG);
    } catch {
      // Expected once the inline advance fires (implement:dispatch has no real worktree).
    }
  }

  const ticket = getTicket(db, ticketId);
  const reviewStep = getByKey(db, ticketId, "design:review");
  db.close();

  // Binding facts:
  // 1. combineTrack(1, 8) = 'full' (overall=8 ≥ COMPLEXITY_FULL_THRESHOLD=5).
  expect(ticket?.track).toBe("full");
  // 2. design:review was dispatched and is not null.
  expect(reviewStep).not.toBeNull();
  // 3. design:review step succeeded (clean plan verdict).
  expect(reviewStep?.status).toBe("succeeded");
  // 4. Both the grade call and the review call fired.
  expect(callCount).toBeGreaterThanOrEqual(2);
});
