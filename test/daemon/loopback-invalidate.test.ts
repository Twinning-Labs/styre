import { expect, test } from "bun:test";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { redesignLoopback } from "../../src/daemon/review-verdict.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import {
  getById as getFinding,
  insertFinding,
  setStatus as setFindingStatus,
} from "../../src/db/repos/review-finding.ts";
import { listStepHistory } from "../../src/db/repos/step-history.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { makeTestDb } from "../helpers/db.ts";
import { type ScriptFinding, newCalls, scriptedRunner, unitsOf } from "../helpers/design-script.ts";
import {
  type DesignTicket,
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

const blocking: ScriptFinding = {
  severity: "critical",
  category: "feasibility",
  location: "plan:Unit 1",
  rationale: "FIX-THE-PLAN",
  factors: null,
  deferral_candidate: false,
  work_unit_seq: 1,
};
const generation = (t: DesignTicket, key: string) =>
  getByKey(t.db, t.ticketId, key)?.generation ?? 0;
const invalidated = (t: DesignTicket) =>
  listEvents(t.db, t.ticketId)
    .filter((e) => e.reason === "invalidated")
    .map(
      (e) =>
        JSON.parse(e.payload_json ?? "{}") as {
          event: string;
          stepKeys: string[];
          cause: string;
          changed: string[];
        },
    );

test(
  "a plan-review redesign invalidates design:dispatch with cause feedback and records the consumer's generation",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
      },
    });
    await driveUntil(t, () => generation(t, "design:dispatch") === 1);
    expect(invalidated(t)).toEqual([
      { event: "invalidated", stepKeys: ["design:dispatch"], cause: "feedback", changed: [] },
    ]);
    const loopback = listEvents(t.db, t.ticketId)
      .filter((e) => e.kind === "loopback")
      .at(-1);
    expect(JSON.parse(loopback?.payload_json ?? "{}")).toMatchObject({
      consumer: "design:dispatch",
      generation: 1,
    });
    expect(listUnits(t.db, t.ticketId).length).toBe(2); // the units stay until the plan's readers are judged
    expect(getByKey(t.db, t.ticketId, "design:review")?.status).toBe("succeeded");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "early cutoff after a plan-review redesign: a changed plan reruns extract and review, not size (§8.5)",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    expect(invalidated(t).map((i) => [i.stepKeys[0], i.cause])).toEqual([
      ["design:dispatch", "feedback"],
      ["design:extract", "inputs"],
      ["design:review", "inputs"],
    ]);
    expect(t.calls.counts["design:review"]).toBe(2);
    expect(generation(t, "design:size")).toBe(0);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a redesign that changes the units reruns size and review (§8.5)",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
        units: (n) => unitsOf(n === 1 ? 2 : 3, { behavioral: true }),
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    const keys = invalidated(t).map((i) => i.stepKeys[0]);
    expect(keys).toContain("design:size");
    expect(keys).toContain("design:review");
    expect(listUnits(t.db, t.ticketId).length).toBe(3);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a code-review redesign re-creates and re-implements the units even when the plan is identical (§8.5)",
  async () => {
    const t = makeDesignTicket({ script: { units: () => unitsOf(2, { behavioral: false }) } });
    // driveUntil sees only the descriptors nextStepKey returns between calls: advanceOneStep runs an
    // `advance` and a `mark-verified` inline, together with the implement dispatch after them
    // (advance.ts:120-136), so stop at the completeness steps, which it returns
    await driveUntil(t, atStep("completeness:wu2")); // both units implemented
    const oldIds = listUnits(t.db, t.ticketId).map((u) => u.id);
    const implementBefore = t.calls.counts.implement;
    const finding = insertFinding(t.db, {
      ticketId: t.ticketId,
      reviewKind: "code",
      severity: "major",
      category: "plan-defect",
      blocksShip: 1,
      workUnitId: oldIds[0],
      rationale: "CODE-FINDING",
    });
    redesignLoopback(t.db, t.ticketId, "review:plan-defect", [finding], null, [
      "design:dispatch",
      "design:extract",
    ]);
    expect(getTicket(t.db, t.ticketId)?.stage).toBe("design");
    expect(getFinding(t.db, finding.id)?.work_unit_id).toBeNull(); // detached, kept open
    // The open finding now goes to unit 1 (findingsForUnit), and its implement must answer exactly
    // its id (assertExactFindingIds). This script's implement answers none. In a real run a code
    // review settles a finding after that implement answered it; this test settles it early, only
    // to keep the run moving, since it is about the units.
    setFindingStatus(t.db, finding.id, "fixed");
    await driveUntil(t, atStep("completeness:wu1"));
    expect(listUnits(t.db, t.ticketId).length).toBe(2);
    // made again: work_unit.id is not AUTOINCREMENT, so the new units may reuse the old ids; the
    // invalidation of design:extract and its second call show it instead
    expect(invalidated(t).flatMap((i) => i.stepKeys)).toContain("design:extract");
    expect(t.calls.counts["design:dispatch"]).toBe(2);
    expect(t.calls.counts["design:extract"]).toBe(2);
    expect(generation(t, "design:size")).toBe(0); // same units: size stays done
    expect(t.calls.counts.implement).toBe(implementBefore + 1); // unit 1 implemented again
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "feedback reaches only its own generation; a later rerun for changed inputs gets none (§6.5, §8.7)",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    const prompts = () =>
      t.calls.prompts.filter((p) => p.step === "design:dispatch").map((p) => p.prompt);
    expect(prompts()[1]).toContain("FIX-THE-PLAN"); // generation 1 got the findings
    captureSnapshot(t.db, t.ticketId, {
      profile: { ...t.profile, promptVars: { stack: "ruby", tone: "terse" } },
      unusableComponents: [],
      nonPrimaryComponents: [],
      config: t.config,
    });
    await driveUntil(t, atStep("checks:dispatch"));
    expect(generation(t, "design:dispatch")).toBe(2);
    expect(prompts()[2]).not.toContain("FIX-THE-PLAN");
    expect(listStepHistory(t.db, t.ticketId, "design:dispatch").length).toBe(2);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the carryover transcript reaches only the generation it was written in (§6.5, §8.7)",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
      },
    });
    const calls = newCalls();
    const registry = buildDispatchRegistry({
      runner: scriptedRunner(t.script, calls),
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile: t.profile,
      worktreeRoot: t.worktreeRoot,
      // manifest null: a transcript written before ENG-477, kept as it is (spec §6.5)
      resumeContext: {
        stepKey: "design:dispatch",
        transcript: "CARRIED-PARTIAL-OUTPUT",
        generation: 0,
        manifest: null,
      },
    });
    await driveUntil({ ...t, registry }, atStep("checks:dispatch"));
    const dispatchPrompts = calls.prompts
      .filter((p) => p.step === "design:dispatch")
      .map((p) => p.prompt);
    expect(dispatchPrompts[0]).toContain("CARRIED-PARTIAL-OUTPUT"); // generation 0
    expect(dispatchPrompts[1]).not.toContain("CARRIED-PARTIAL-OUTPUT"); // generation 1, after the redesign
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a carryover recorded under other inputs is dropped, with a note naming them (spec §6.5)",
  async () => {
    const t = makeDesignTicket({ script: { planFindings: () => [] } });
    const calls = newCalls();
    const registry = buildDispatchRegistry({
      runner: scriptedRunner(t.script, calls),
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile: t.profile,
      worktreeRoot: t.worktreeRoot,
      resumeContext: {
        stepKey: "design:dispatch",
        transcript: "CARRIED-PARTIAL-OUTPUT",
        generation: 0,
        manifest: { "profile.promptVars": "a digest no current input has" },
      },
    });
    await driveUntil({ ...t, registry }, atStep("checks:dispatch"));
    const dispatchPrompts = calls.prompts
      .filter((p) => p.step === "design:dispatch")
      .map((p) => p.prompt);
    expect(dispatchPrompts[0]).not.toContain("CARRIED-PARTIAL-OUTPUT");
    const notes = listEvents(t.db, t.ticketId)
      .filter((e) => e.reason === "carryover-dropped")
      .map((e) => JSON.parse(e.payload_json ?? "{}") as { stepKey: string; changed: string[] });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.stepKey).toBe("design:dispatch");
    expect(notes[0]?.changed).toContain("profile.promptVars");
  },
  STEP_TEST_TIMEOUT_MS,
);

test("a redesign that does not invalidate design:dispatch, its feedback's consumer, is refused and writes nothing", () => {
  const { db, ticketId } = makeTestDb();
  const stage = getTicket(db, ticketId)?.stage;
  expect(() => redesignLoopback(db, ticketId, "review:x", [], null, ["design:extract"])).toThrow(
    "redesignLoopback: a redesign must invalidate design:dispatch, its feedback's consumer",
  );
  expect(listEvents(db, ticketId)).toEqual([]);
  expect(getTicket(db, ticketId)?.stage).toBe(stage);
  db.close();
});
