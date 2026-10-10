// test/dispatch/design-commits.test.ts
import { expect, test } from "bun:test";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunInput } from "../../src/agent/runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import {
  writeExtractOutputs,
  writePlanFindings,
  writeSizeOutput,
} from "../../src/daemon/design-outputs.ts";
import { type StepHandler, StepRegistry } from "../../src/daemon/step-registry.ts";
import {
  latestDispatchForStep,
  listByTicket as listFindings,
} from "../../src/db/repos/review-finding.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import {
  ADDRESSED_CDOT,
  type ScriptFinding,
  type ScriptUnit,
  scriptedRunner,
  sidecar,
  stepOfPrompt,
  unitsOf,
} from "../helpers/design-script.ts";
import {
  type DesignTicket,
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

const KEYS = [
  "provision",
  "design:dispatch",
  "design:extract",
  "design:size",
  "design:review",
  "checks:dispatch",
  "checks:classify",
];

/** The real registry, with one step's commit made to throw on its first call: the handler's work is
 *  done and returned, but the success transaction never commits (a crash at that point). */
function failFirstCommit(real: StepRegistry, handlerKey: string): StepRegistry {
  let failed = false;
  const wrapped = new StepRegistry(real.synchronize);
  for (const key of KEYS) {
    const handler = real.resolve(key);
    if (!handler) continue;
    const commit = real.resolveCommit(key);
    wrapped.register(key, handler, {
      commit: (db, ticketId, result) => {
        if (key === handlerKey && !failed) {
          failed = true;
          throw new Error(`injected: the success transaction of ${key} did not commit`);
        }
        commit?.(db, ticketId, result);
      },
    });
  }
  return wrapped;
}

/** The real registry, with `observe` called inside the success transaction of `handlerKey` just
 *  before its real commit, so a test can record what the handler left in the database. It records
 *  only: an expect inside the transaction would be swallowed by the rollback path. */
function observeBeforeCommit(
  real: StepRegistry,
  handlerKey: string,
  observe: (ticketId: number) => void,
  handlerOverride?: StepHandler,
): StepRegistry {
  const wrapped = new StepRegistry(real.synchronize);
  for (const key of KEYS) {
    const handler = real.resolve(key);
    if (!handler) continue;
    const commit = real.resolveCommit(key);
    wrapped.register(key, key === handlerKey && handlerOverride ? handlerOverride : handler, {
      commit: (db, ticketId, result) => {
        if (key === handlerKey) observe(ticketId);
        commit?.(db, ticketId, result);
      },
    });
  }
  return wrapped;
}

/** One step through `registry`, then wait for the background leftover check it started. */
async function step(t: DesignTicket, registry: StepRegistry) {
  const outcome = await advanceOneStep(t.db, t.ticketId, registry, { config: t.config });
  await pendingLeftoverChecks();
  return outcome;
}

const errorOf = (t: DesignTicket, key: string): string =>
  (JSON.parse(getByKey(t.db, t.ticketId, key)?.error_json ?? "{}") as { message?: string })
    .message ?? "";

test(
  "a design:extract whose success did not commit leaves no units, and its rerun writes them once",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("design:extract"));
    const registry = failFirstCommit(t.registry, "design:extract");
    const first = await step(t, registry);
    expect(first.kind).toBe("retry");
    expect(listUnits(t.db, t.ticketId)).toEqual([]);
    const failed = getByKey(t.db, t.ticketId, "design:extract");
    expect(failed?.status).not.toBe("succeeded");
    expect(errorOf(t, "design:extract")).toBe(
      "injected: the success transaction of design:extract did not commit",
    );
    // the manifest is written in the same transaction, so it rolled back too
    expect(failed?.input_fingerprint).toBeNull();
    expect(failed?.input_manifest).toBeNull();
    expect(getTicket(t.db, t.ticketId)?.needs_docs).toBe(0);
    await driveUntil({ ...t, registry }, atStep("design:size"));
    expect(listUnits(t.db, t.ticketId).map((u) => u.seq)).toEqual([1, 2]); // no UNIQUE (ticket_id, seq) error
    expect(t.calls.counts["design:extract"]).toBe(2);
    const done = getByKey(t.db, t.ticketId, "design:extract");
    expect(done?.status).toBe("succeeded");
    expect(done?.input_fingerprint).not.toBeNull();
    expect(getTicket(t.db, t.ticketId)?.needs_docs).toBe(0); // documentation does not apply
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:size writes the track only when its success commits",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("design:size"));
    const registry = failFirstCommit(t.registry, "design:size");
    await step(t, registry);
    expect(getTicket(t.db, t.ticketId)?.track).toBeNull();
    expect(errorOf(t, "design:size")).toBe(
      "injected: the success transaction of design:size did not commit",
    );
    expect(getByKey(t.db, t.ticketId, "design:size")?.input_fingerprint).toBeNull();
    await step(t, registry);
    expect(getTicket(t.db, t.ticketId)?.track).toBe("full");
    expect(getByKey(t.db, t.ticketId, "design:size")?.input_fingerprint).not.toBeNull();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:review's findings are written before its verdict reads them, and only on success",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: () => [
          {
            severity: "critical",
            category: "feasibility",
            location: "plan:Unit 1",
            rationale: "not feasible",
            factors: null,
            deferral_candidate: false,
            // tied to no unit: until Task 14, today's redesign deletes the units with the findings
            // tied to them, and this test counts the plan finding after the loopback
            work_unit_seq: null,
          },
        ],
      },
    });
    await driveUntil(t, atStep("design:review"));
    const registry = failFirstCommit(t.registry, "design:review");
    await step(t, registry); // commit fails: no rows
    expect(listFindings(t.db, t.ticketId)).toEqual([]);
    expect(errorOf(t, "design:review")).toBe(
      "injected: the success transaction of design:review did not commit",
    );
    expect(getByKey(t.db, t.ticketId, "design:review")?.input_fingerprint).toBeNull();
    const outcome = await step(t, registry);
    expect(outcome).toEqual({ kind: "loopback", stepKey: "design:review" }); // the verdict saw the row
    const plan = listFindings(t.db, t.ticketId).filter((f) => f.review_kind === "plan");
    expect(plan.length).toBe(1);
    expect(plan[0]?.blocks_ship).toBe(1);
    expect(plan[0]?.dispatch_id).toBe(latestDispatchForStep(t.db, t.ticketId, "design:review"));
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:extract writes nothing itself; its commit writes every unit field with origin extract, and needs_docs",
  async () => {
    // one behavioural unit and one that is not, depending on the first: every field differs from
    // insertWorkUnit's defaults somewhere
    const [first] = unitsOf(1, { behavioral: true });
    if (!first) throw new Error("unitsOf returned no unit");
    const mixed: ScriptUnit[] = [
      first,
      {
        seq: 2,
        kind: "frontend",
        title: "Unit 2",
        description: "Change 2",
        behavioral: false,
        test_plan: null,
        files_to_touch: ["lib/u2.rb"],
        verify_check_types: ["visual"],
        depends_on: [1],
      },
    ];
    const t = makeDesignTicket({ script: { units: () => mixed } });
    // documentation applies: the agent says the change needs docs
    const inner = scriptedRunner(t.script, t.calls);
    const runner = new FakeAgentRunner(async (input: AgentRunInput) => {
      const r = await inner.run(input);
      if (stepOfPrompt(input.prompt) !== "design:extract") return r;
      const cdotImpact = {
        ...ADDRESSED_CDOT,
        documentation: { applies: true, analysis: "the README changes" },
      };
      return { ...r, stdout: sidecar({ units: t.script.units(1), cdotImpact }) };
    });
    const real = buildDispatchRegistry({
      runner,
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile: t.profile,
      worktreeRoot: t.worktreeRoot,
    });
    const seen: Array<{ units: number; needsDocs: number | undefined }> = [];
    const registry = observeBeforeCommit(real, "design:extract", (ticketId) =>
      seen.push({
        units: listUnits(t.db, ticketId).length,
        needsDocs: getTicket(t.db, ticketId)?.needs_docs,
      }),
    );
    await driveUntil({ ...t, registry }, atStep("design:extract"));
    expect(await step(t, registry)).toEqual({ kind: "stepped", stepKey: "design:extract" });
    // the handler had returned and written nothing when its commit began
    expect(seen).toEqual([{ units: 0, needsDocs: 0 }]);
    const expected = t.script.units(1);
    expect(expected.length).toBe(2);
    const units = listUnits(t.db, t.ticketId);
    expect(
      units.map((u) => ({
        seq: u.seq,
        kind: u.kind,
        title: u.title,
        description: u.description,
        status: u.status,
        behavioral: u.behavioral,
        test_plan: u.test_plan,
        files_to_touch: u.files_to_touch,
        verify_check_types: u.verify_check_types,
        depends_on: u.depends_on,
        origin: u.origin,
      })),
    ).toEqual(
      expected.map((u) => ({
        seq: u.seq,
        kind: u.kind,
        title: u.title,
        description: u.description,
        status: "pending",
        behavioral: u.behavioral ? 1 : 0,
        test_plan: u.test_plan,
        files_to_touch: JSON.stringify(u.files_to_touch),
        verify_check_types: JSON.stringify(u.verify_check_types),
        depends_on: JSON.stringify(u.depends_on),
        origin: "extract",
      })),
    );
    expect(getTicket(t.db, t.ticketId)?.needs_docs).toBe(1);
    const recorded = JSON.parse(getByKey(t.db, t.ticketId, "design:extract")?.result_json ?? "{}");
    expect(recorded).toEqual({ units: 2, extracted: expected, needsDocs: true });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:size (grading off) writes nothing itself; its commit writes the sprawl track",
  async () => {
    const t = makeDesignTicket();
    const seen: Array<string | null | undefined> = [];
    const registry = observeBeforeCommit(t.registry, "design:size", (ticketId) =>
      seen.push(getTicket(t.db, ticketId)?.track),
    );
    await driveUntil({ ...t, registry }, atStep("design:size"));
    expect(await step(t, registry)).toEqual({ kind: "stepped", stepKey: "design:size" });
    expect(seen).toEqual([null]);
    expect(getTicket(t.db, t.ticketId)?.track).toBe("full"); // two units: sprawl says full
    expect(JSON.parse(getByKey(t.db, t.ticketId, "design:size")?.result_json ?? "{}")).toEqual({
      track: "full",
      graded: false,
    });
    expect(t.calls.counts["design:size"]).toBe(0); // no grader dispatch when grading is off
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:size (grading on) writes nothing itself; its commit writes the graded track",
  async () => {
    // a low grade keeps two units fast, where sprawl alone would say full
    const t = makeDesignTicket({ config: { complexityGrading: true }, script: { grade: () => 2 } });
    const seen: Array<string | null | undefined> = [];
    const registry = observeBeforeCommit(t.registry, "design:size", (ticketId) =>
      seen.push(getTicket(t.db, ticketId)?.track),
    );
    await driveUntil({ ...t, registry }, atStep("design:size"));
    expect(await step(t, registry)).toEqual({ kind: "stepped", stepKey: "design:size" });
    expect(seen).toEqual([null]);
    expect(getTicket(t.db, t.ticketId)?.track).toBe("fast");
    expect(JSON.parse(getByKey(t.db, t.ticketId, "design:size")?.result_json ?? "{}")).toEqual({
      track: "fast",
      graded: true,
      overall: 2,
    });
    expect(t.calls.counts["design:size"]).toBe(1);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:review writes nothing itself; its commit writes every finding field as rows of its dispatch",
  async () => {
    const findings: ScriptFinding[] = [
      {
        severity: "minor",
        category: "testing",
        location: "plan:Unit 2",
        rationale: "the test plan is thin",
        factors: null,
        deferral_candidate: false, // a plan finding is never a deferral candidate
        work_unit_seq: 2,
      },
      {
        severity: "nit",
        category: "style",
        location: null,
        rationale: "wording",
        factors: null,
        deferral_candidate: false,
        work_unit_seq: null,
      },
    ];
    const t = makeDesignTicket({ script: { planFindings: () => findings } });
    const seen: number[] = [];
    const registry = observeBeforeCommit(t.registry, "design:review", (ticketId) =>
      seen.push(listFindings(t.db, ticketId).length),
    );
    await driveUntil({ ...t, registry }, atStep("design:review"));
    // minor and nit block nothing, so the verdict is clean and the units stay
    expect(await step(t, registry)).toEqual({ kind: "stepped", stepKey: "design:review" });
    expect(seen).toEqual([0]);
    const unit2 = listUnits(t.db, t.ticketId).find((u) => u.seq === 2);
    expect(unit2).toBeDefined();
    const dispatchId = latestDispatchForStep(t.db, t.ticketId, "design:review");
    expect(dispatchId).not.toBeNull();
    const rows = listFindings(t.db, t.ticketId);
    expect(
      rows.map((f) => ({
        review_kind: f.review_kind,
        dispatch_id: f.dispatch_id,
        work_unit_id: f.work_unit_id,
        severity: f.severity,
        category: f.category,
        factors_json: f.factors_json,
        deferral_candidate: f.deferral_candidate,
        blocks_ship: f.blocks_ship,
        location: f.location,
        rationale: f.rationale,
        status: f.status,
      })),
    ).toEqual([
      {
        review_kind: "plan",
        dispatch_id: dispatchId,
        work_unit_id: unit2?.id ?? -1,
        severity: "minor",
        category: "testing",
        factors_json: null,
        deferral_candidate: 0,
        blocks_ship: 0,
        location: "plan:Unit 2",
        rationale: "the test plan is thin",
        status: "open",
      },
      {
        review_kind: "plan",
        dispatch_id: dispatchId,
        work_unit_id: null,
        severity: "nit",
        category: "style",
        factors_json: null,
        deferral_candidate: 0,
        blocks_ship: 0,
        location: null,
        rationale: "wording",
        status: "open",
      },
    ]);
    const recorded = JSON.parse(getByKey(t.db, t.ticketId, "design:review")?.result_json ?? "{}");
    expect({ findings: recorded.findings, blocking: recorded.blocking }).toEqual({
      findings: 2,
      blocking: 0,
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a design:extract result of the wrong shape is refused by its commit: the step fails, naming the step, and writes nothing",
  async () => {
    const t = makeDesignTicket();
    // the pre-ENG-477 result shape: a count, no rows
    const registry = observeBeforeCommit(
      t.registry,
      "design:extract",
      () => {},
      () => ({ units: 2 }),
    );
    await driveUntil({ ...t, registry }, atStep("design:extract"));
    expect((await step(t, registry)).kind).toBe("retry");
    expect(errorOf(t, "design:extract")).toStartWith(
      "design:extract: the step's result is malformed:",
    );
    expect(listUnits(t.db, t.ticketId)).toEqual([]);
    expect(getByKey(t.db, t.ticketId, "design:extract")?.input_fingerprint).toBeNull();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "each commit refuses a malformed result loudly, naming its step, before it writes any row",
  async () => {
    const t = makeDesignTicket();
    const unit = {
      seq: 1,
      kind: "backend",
      title: "U",
      description: "D",
      behavioral: false,
      test_plan: null,
      files_to_touch: ["src/a.ts"],
      verify_check_types: [],
      depends_on: [],
    };
    const finding = {
      workUnitId: null,
      severity: "major",
      category: "c",
      factorsJson: null,
      deferralCandidate: 0,
      blocksShip: 1,
      location: null,
      rationale: "r",
    };
    const cases: Array<[string, () => void]> = [
      ["design:extract", () => writeExtractOutputs(t.db, t.ticketId, null)],
      ["design:extract", () => writeExtractOutputs(t.db, t.ticketId, { units: 1 })],
      // a count that disagrees with the rows
      [
        "design:extract",
        () =>
          writeExtractOutputs(t.db, t.ticketId, { units: 2, extracted: [unit], needsDocs: false }),
      ],
      [
        "design:extract",
        () =>
          writeExtractOutputs(t.db, t.ticketId, {
            units: 1,
            extracted: [{ ...unit, behavioral: "yes" }],
            needsDocs: false,
          }),
      ],
      ["design:size", () => writeSizeOutput(t.db, t.ticketId, { track: "medium", graded: false })],
      ["design:size", () => writeSizeOutput(t.db, t.ticketId, { track: "full" })],
      [
        "design:review",
        () => writePlanFindings(t.db, t.ticketId, { findings: 1, blocking: 1, filed: [finding] }),
      ],
      [
        "design:review",
        () =>
          writePlanFindings(t.db, t.ticketId, {
            findings: 2,
            blocking: 1,
            dispatchId: "D-1",
            filed: [finding],
          }),
      ],
      [
        "design:review",
        () =>
          writePlanFindings(t.db, t.ticketId, {
            findings: 1,
            blocking: 0,
            dispatchId: "D-1",
            filed: [finding],
          }),
      ],
      [
        "design:review",
        () =>
          writePlanFindings(t.db, t.ticketId, {
            findings: 1,
            blocking: 0,
            dispatchId: "D-1",
            filed: [{ ...finding, blocksShip: 2 }],
          }),
      ],
    ];
    const messages: string[] = [];
    for (const [, write] of cases) {
      try {
        write();
        messages.push("(no error)");
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    expect(messages.length).toBe(cases.length);
    messages.forEach((m, i) => {
      expect(m).toStartWith(`${cases[i]?.[0]}: the step's result is malformed:`);
    });
    expect(listUnits(t.db, t.ticketId)).toEqual([]);
    expect(getTicket(t.db, t.ticketId)?.track).toBeNull();
    expect(listFindings(t.db, t.ticketId)).toEqual([]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "writePlanFindings writes each field it is given, under the result's dispatch id",
  async () => {
    const t = makeDesignTicket();
    t.db.transaction(() =>
      writePlanFindings(t.db, t.ticketId, {
        findings: 2,
        blocking: 1,
        dispatchId: "ENG-1-d0099",
        filed: [
          {
            workUnitId: null,
            severity: "major",
            category: "risk",
            factorsJson: JSON.stringify({ reversible: false }),
            deferralCandidate: 1,
            blocksShip: 1,
            location: "plan:Risks",
            rationale: "irreversible",
          },
          {
            workUnitId: null,
            severity: "minor",
            category: "clarity",
            factorsJson: null,
            deferralCandidate: 0,
            blocksShip: null,
            location: null,
            rationale: "unclear",
          },
        ],
      }),
    )();
    expect(
      listFindings(t.db, t.ticketId).map((f) => [
        f.review_kind,
        f.dispatch_id,
        f.work_unit_id,
        f.severity,
        f.category,
        f.factors_json,
        f.deferral_candidate,
        f.blocks_ship,
        f.location,
        f.rationale,
      ]),
    ).toEqual([
      [
        "plan",
        "ENG-1-d0099",
        null,
        "major",
        "risk",
        '{"reversible":false}',
        1,
        1,
        "plan:Risks",
        "irreversible",
      ],
      ["plan", "ENG-1-d0099", null, "minor", "clarity", null, 0, null, null, "unclear"],
    ]);
  },
  STEP_TEST_TIMEOUT_MS,
);
