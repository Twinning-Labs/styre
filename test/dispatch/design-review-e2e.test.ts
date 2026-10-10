import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { listOpenByTicket } from "../../src/db/repos/review-finding.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import { makeTestDb } from "../helpers/db.ts";
import { type ScriptUnit, unitsOf } from "../helpers/design-script.ts";
import { STEP_TEST_TIMEOUT_MS, reachDesignStep } from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

// The steps that dispatch an agent start a background leftover check (ENG-485 section 9.1); one
// still running when the test ends keeps the command temp folder.
afterEach(pendingLeftoverChecks);

function gitRepo(): string {
  const root = makeTempDir("styre-dre-");
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

const ABSENT_RC = {
  topology: { type: "cli" },
  data: { presence: "absent" },
  caching: { presence: "absent" },
  observability: { presence: "absent" },
  configSecrets: { presence: "absent" },
  documentation: { presence: "absent" },
  releasePackaging: { mechanism: "none" },
};

function profileFor(repo: string) {
  return parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "app", kind: "node", paths: ["**"], commands: { test: "bun test" } }],
    runtimeContext: ABSENT_RC,
  });
}

const roots = new Map<string, string>();
function rootFor(repo: string): string {
  let root = roots.get(repo);
  if (root === undefined) {
    root = makeTempDir("styre-drewt-");
    roots.set(repo, root);
  }
  return root;
}

function registryFor(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: profileFor(repo),
    worktreeRoot: rootFor(repo),
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

// The two backend units it seeded, neither behavioural
const REVIEW_UNITS: ScriptUnit[] = unitsOf(2, { behavioral: false, dir: "src", ext: "ts" }).map(
  (u) => ({
    ...u,
    verify_check_types: ["test"],
  }),
);

/** The real provision and design steps run first (spec §8), so the resolver routes to
 *  design:review: two units, which size to track 'full'. */
async function readyForDesignReview(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  repo: string,
): Promise<void> {
  await reachDesignStep({
    db,
    ticketId,
    profile: profileFor(repo),
    worktreeRoot: rootFor(repo),
    target: "design:review",
    units: REVIEW_UNITS,
  });
}

/** The real provision and design:dispatch steps run first (spec §8), so the resolver routes to
 *  design:extract. */
async function readyForExtract(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  repo: string,
): Promise<void> {
  await reachDesignStep({
    db,
    ticketId,
    profile: profileFor(repo),
    worktreeRoot: rootFor(repo),
    target: "design:extract",
  });
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

test(
  "full-track clean plan (no findings) advances ticket from design to implement with no review_finding rows",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForDesignReview(db, ticketId, repo);

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

    // Drive advanceOneStep until the ticket leaves design: design:review (clean verdict) is now
    // followed by the hoisted provision (no `prepare` on this kind:"app" profile → no-op) and
    // checks:dispatch (null ticket description → 0 ACs → no-op, decision 6) before the resolver's
    // inline advance design→implement fires. This runner returns a clean-plan sidecar unconditionally
    // (no throw-on-unexpected-call gate), so a subsequent implement:wu1:dispatch attempt succeeds too.
    for (let i = 0; i < 10; i++) {
      const t = getTicket(db, ticketId);
      if (!t || t.stage !== "design") break;
      try {
        await advanceOneStep(db, ticketId, registry);
      } catch {
        // Defensive: not expected to throw with this runner, but the binding fact under test is
        // stage=implement, not any particular intermediate step's outcome.
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
  },
  STEP_TEST_TIMEOUT_MS,
);

// ─── Flow 2: Full-track, blocking plan finding → re-design ───────────────────

test(
  "blocking plan finding loops back to design: stage=design, work_units cleared, design:review reset to pending",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForDesignReview(db, ticketId, repo);

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
  },
  STEP_TEST_TIMEOUT_MS,
);

// ─── Flow 3: Repeated identical blocking plan round → escalate ────────────────

test(
  "repeated identical blocking plan finding escalates ticket to waiting with human_resume signal pending",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForDesignReview(db, ticketId, repo);

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
  },
  STEP_TEST_TIMEOUT_MS,
);

// ─── Flow 4: Fast-track ticket SKIPS design:review ───────────────────────────

test(
  "fast-track ticket (1 unit, track=fast) advances design→implement WITHOUT ever creating design:review step",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);

    // provision and design:dispatch run as real steps (readyForExtract, spec §8). track is left NULL
    // so the real sizer decides.
    await readyForExtract(db, ticketId, repo);
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
  },
  STEP_TEST_TIMEOUT_MS,
);
