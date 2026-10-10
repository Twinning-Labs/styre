import { expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { FINGERPRINT_SCHEME } from "../../src/daemon/canonical.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { invalidateSteps } from "../../src/daemon/invalidate.ts";
import { type StepDescriptor, nextStepKey } from "../../src/daemon/resolver.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { requiredPlanFindings } from "../../src/db/repos/review-round.ts";
import { listStepHistory } from "../../src/db/repos/step-history.ts";
import { getTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey, recordManifest } from "../../src/db/repos/workflow-step.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import { unitsOf } from "../helpers/design-script.ts";
import {
  type DesignTicket,
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

const recapture = (t: DesignTicket, profile = t.profile, complexityGrading = false) =>
  captureSnapshot(t.db, t.ticketId, {
    profile,
    unusableComponents: [],
    nonPrimaryComponents: [],
    config: { complexityGrading },
  });

test(
  "the design stage routes provision, dispatch, extract, size, review, then the checks steps, then advances",
  async () => {
    const t = makeDesignTicket({ script: { units: () => unitsOf(2, { behavioral: false }) } });
    const seen: string[] = [];
    const descriptors: StepDescriptor[] = [];
    const d = await driveUntil(t, (next) => {
      if (next.kind === "step") seen.push(next.stepKey);
      if (next.kind === "step") descriptors.push(next);
      return next.kind === "advance";
    });
    expect(d).toEqual({ kind: "advance", from: "design", to: "implement" });
    expect(seen).toEqual([
      "provision",
      "design:dispatch",
      "design:extract",
      "design:size",
      "design:review",
      "checks:dispatch",
      "checks:classify",
    ]);
    // each design descriptor comes from its table row: its type and handler, no work unit
    const row = (stepKey: string, stepType: string): StepDescriptor => ({
      kind: "step",
      stepKey,
      stepType,
      handlerKey: stepKey,
      workUnitId: null,
    });
    expect(descriptors.slice(0, 5)).toEqual([
      row("provision", "provision"),
      row("design:dispatch", "dispatch"),
      row("design:extract", "dispatch"),
      row("design:size", "dispatch"),
      row("design:review", "dispatch"),
    ]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a fast track skips design:review and its gate",
  async () => {
    const t = makeDesignTicket({ script: { units: () => unitsOf(1, { behavioral: false }) } });
    const seen: string[] = [];
    await driveUntil(t, (next) => {
      if (next.kind === "step") seen.push(next.stepKey);
      return next.kind === "advance";
    });
    expect(seen).not.toContain("design:review");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a changed input invalidates exactly the first step that reads it, naming the input",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    recapture(t, { ...t.profile, promptVars: { stack: "ruby", tone: "terse" } });
    expect(nextStepKey(t.db, t.ticketId)).toEqual({
      kind: "invalidate",
      stepKeys: ["design:dispatch"],
      reason: { cause: "inputs", changed: ["profile.promptVars"] },
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "early cutoff: a rerun whose output is unchanged leaves the steps that read it done",
  async () => {
    // runtimeContext is read by dispatch and extract only. The plan is unchanged, so size and review
    // (which read the plan and the units) stay done. The other half, a changed output invalidating
    // its readers next, is the renamed plan file test below.
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    recapture(t, {
      ...t.profile,
      runtimeContext: {
        ...t.profile.runtimeContext,
        topology: { type: "web-service", detail: "" },
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    const invalidated = listEvents(t.db, t.ticketId)
      .filter((e) => e.reason === "invalidated")
      .map((e) => JSON.parse(e.payload_json ?? "{}").stepKeys[0]);
    expect(invalidated).toEqual(["design:dispatch", "design:extract"]);
    expect(t.calls.counts["design:review"]).toBe(1);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:extract and design:size are gated by the walk, not by rows or columns",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    recapture(t, t.profile, true); // grading on: size's inputs change; the track column is still set
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "invalidate",
      stepKeys: ["design:size"],
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the walk runs only in design: past design an edit is not compared (E6)",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    setTicketStage(t.db, t.ticketId, "implement");
    recapture(t, { ...t.profile, promptVars: { stack: "other" } });
    expect(nextStepKey(t.db, t.ticketId).kind).not.toBe("invalidate");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a succeeded design step with no manifest is refused loudly (the adopt pass did not run)",
  async () => {
    const t = makeDesignTicket();
    await runStep(t.db, {
      ticketId: t.ticketId,
      stepKey: "provision",
      stepType: "provision",
      execute: () => ({}),
    });
    expect(() => nextStepKey(t.db, t.ticketId)).toThrow("without an input manifest");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a manifest recorded under an older scheme counts as changed: the step reruns (ruling 2026-10-09)",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    const step = getByKey(t.db, t.ticketId, "design:dispatch");
    if (!step?.input_manifest) throw new Error("design:dispatch recorded no manifest");
    // What an older scheme left: the same manifest, stamped with the previous scheme number.
    recordManifest(t.db, step.id, {
      manifest: JSON.parse(step.input_manifest) as Record<string, string>,
      fingerprint: step.input_fingerprint ?? "",
      outputDigest: step.output_digest,
      scheme: FINGERPRINT_SCHEME - 1,
    });
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "invalidate",
      stepKeys: ["design:dispatch"],
      reason: { cause: "inputs" },
    });
    // past design the walk does not run: the change waits for the next design visit
    setTicketStage(t.db, t.ticketId, "implement");
    expect(nextStepKey(t.db, t.ticketId).kind).not.toBe("invalidate");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the plan-review gate escalates while blocking findings remain on the latest review",
  async () => {
    const blocking = {
      severity: "critical" as const,
      category: "feasibility",
      location: "plan:Unit 1",
      rationale: "not feasible",
      factors: null,
      deferral_candidate: false,
      work_unit_seq: 1,
    };
    const t = makeDesignTicket({ script: { planFindings: () => [blocking] } });
    // round 1 blocks → redesign; the plan does not change, so the latest review's blocking findings
    // remain and the gate row fires
    await driveUntil(t, (d) => d.kind === "escalate", 30);
    expect(getByKey(t.db, t.ticketId, "design:review")?.status).toBe("succeeded");
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "escalate",
      signature: "review:unresolved-plan",
      stepKey: "design:review",
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the plan-review gate applies only where its step does: a resize to fast leaves the findings and goes on",
  async () => {
    const blocking = {
      severity: "critical" as const,
      category: "feasibility",
      location: "plan:Unit 1",
      rationale: "not feasible",
      factors: null,
      deferral_candidate: false,
      work_unit_seq: 1,
    };
    // grading on: one unit graded 8 sizes full, the same unit graded 1 sizes fast
    const t = makeDesignTicket({
      config: { complexityGrading: true },
      script: {
        units: () => unitsOf(1, { behavioral: false }),
        grade: (n) => (n === 1 ? 8 : 1),
        planFindings: () => [blocking],
      },
    });
    await driveUntil(t, (d) => d.kind === "escalate", 30);
    expect(getTicket(t.db, t.ticketId)?.track).toBe("full");
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "escalate",
      signature: "review:unresolved-plan",
    });
    const escalationsBefore = listEvents(t.db, t.ticketId).filter(
      (e) => e.kind === "escalated",
    ).length;
    // an edited prompt variable reruns the steps that read it, design:size among them (graded 1)
    recapture(t, { ...t.profile, promptVars: { stack: "ruby", tone: "terse" } }, true);
    const d = await driveUntil(
      t,
      (next) => next.kind === "escalate" || atStep("checks:dispatch")(next),
      20,
    );
    expect(d).toMatchObject({ kind: "step", stepKey: "checks:dispatch" });
    expect(t.calls.counts["design:size"]).toBe(2);
    expect(getTicket(t.db, t.ticketId)?.track).toBe("fast");
    // the latest review's blocking findings remain, but neither the review nor its gate applies
    expect(requiredPlanFindings(t.db, t.ticketId).length).toBeGreaterThan(0);
    expect(listEvents(t.db, t.ticketId).filter((e) => e.kind === "escalated").length).toBe(
      escalationsBefore,
    );
  },
  STEP_TEST_TIMEOUT_MS,
);

/** The `invalidated` notes so far, in order: each one's step keys, cause and changed inputs. */
const invalidatedNotes = (t: DesignTicket) =>
  listEvents(t.db, t.ticketId)
    .filter((e) => e.reason === "invalidated")
    .map((e) => {
      const p = JSON.parse(e.payload_json ?? "{}") as {
        stepKeys: string[];
        cause: string;
        changed: string[];
      };
      return { stepKeys: p.stepKeys, cause: p.cause, changed: p.changed };
    });

test(
  "the real walk's invalidate is applied end to end: note, history, a fresh round, the rerun",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    const before = getByKey(t.db, t.ticketId, "design:dispatch");
    if (!before) throw new Error("design:dispatch has no row");
    expect(listStepHistory(t.db, t.ticketId, "design:dispatch")).toEqual([]);
    recapture(t, { ...t.profile, promptVars: { stack: "ruby", tone: "terse" } });
    // One call: the walk returns the invalidate, advance applies it and runs the step it reset.
    const outcome = await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
    await pendingLeftoverChecks();
    expect(outcome).toEqual({ kind: "stepped", stepKey: "design:dispatch" });
    const notes = listEvents(t.db, t.ticketId).filter((e) => e.reason === "invalidated");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("note");
    expect(JSON.parse(notes[0]?.payload_json ?? "{}")).toEqual({
      event: "invalidated",
      stepKeys: ["design:dispatch"],
      cause: "inputs",
      changed: ["profile.promptVars"],
    });
    const history = listStepHistory(t.db, t.ticketId, "design:dispatch");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      event_id: notes[0]?.id,
      status: "succeeded",
      generation: before.generation,
      input_manifest: before.input_manifest,
    });
    const after = getByKey(t.db, t.ticketId, "design:dispatch");
    expect(after?.generation).toBe(before.generation + 1);
    expect(after?.status).toBe("succeeded");
    expect(after?.attempt).toBe(1); // a fresh round, not a retry
    expect(t.calls.counts["design:dispatch"]).toBe(2);
    // the new manifest holds the edited promptVars: the step is done with the inputs it has now
    const recorded = JSON.parse(after?.input_manifest ?? "{}") as Record<string, string>;
    expect(recorded["profile.promptVars"]).not.toBe(
      (JSON.parse(before.input_manifest ?? "{}") as Record<string, string>)["profile.promptVars"],
    );
    // the next reader of promptVars is judged only now, after design:dispatch reran (one at a time)
    expect(nextStepKey(t.db, t.ticketId)).toEqual({
      kind: "invalidate",
      stepKeys: ["design:extract"],
      reason: { cause: "inputs", changed: ["profile.promptVars"] },
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a renamed plan file (same content) reruns every reader of the plan: extract, size with grading on, review (Review Focus 5)",
  async () => {
    const t = makeDesignTicket({
      config: { complexityGrading: true },
      script: {
        planFile: (n) => (n === 1 ? "eng-1-plan.md" : "eng-1-plan-renamed.md"),
        renamePlan: true,
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    expect(t.calls.counts).toMatchObject({
      "design:dispatch": 1,
      "design:extract": 1,
      "design:size": 1,
      "design:review": 1,
    });
    // Rerun design:dispatch alone, as a plan review redesign does (spec §6.4).
    invalidateSteps(t.db, t.ticketId, ["design:dispatch"], { cause: "feedback" });
    await driveUntil(t, atStep("checks:dispatch"));
    expect(invalidatedNotes(t)).toEqual([
      { stepKeys: ["design:dispatch"], cause: "feedback", changed: [] },
      { stepKeys: ["design:extract"], cause: "inputs", changed: ["plan"] },
      { stepKeys: ["design:size"], cause: "inputs", changed: ["plan"] },
      { stepKeys: ["design:review"], cause: "inputs", changed: ["plan"] },
    ]);
    expect(t.calls.counts).toMatchObject({
      "design:dispatch": 2,
      "design:extract": 2,
      "design:size": 2,
      "design:review": 2,
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a plan file of no ticket, another ticket's plan, or a nested file reruns no reader of the plan (Review Focus 5)",
  async () => {
    const t = makeDesignTicket({
      config: { complexityGrading: true },
      script: {
        extraFiles: (n) =>
          n === 1
            ? []
            : [
                { path: "docs/plans/notes.md", content: "no frontmatter\n" },
                { path: "docs/plans/eng-2-plan.md", content: "---\nlinear: ENG-2\n---\n\nOther\n" },
                {
                  path: "docs/plans/archive/eng-1-old.md",
                  content: "---\nlinear: ENG-1\n---\n\nNested\n",
                },
              ],
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    invalidateSteps(t.db, t.ticketId, ["design:dispatch"], { cause: "feedback" });
    await driveUntil(t, atStep("checks:dispatch"));
    // the rerun wrote and committed the extra files: they are on the branch, yet no reader reruns
    expect(t.calls.counts["design:dispatch"]).toBe(2);
    expect(invalidatedNotes(t)).toEqual([
      { stepKeys: ["design:dispatch"], cause: "feedback", changed: [] },
    ]);
    expect(t.calls.counts).toMatchObject({
      "design:extract": 1,
      "design:size": 1,
      "design:review": 1,
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "units left by an older Styre's crash inside design:extract are replaced, never carried on (Task 11 carry)",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("design:extract"));
    // Stated exception (no real step can produce it): an older Styre inserted extract's units one
    // by one before marking the step succeeded, so a crash between them left a partial unit and
    // design:extract not succeeded. This Styre writes units only in the success transaction.
    insertWorkUnit(t.db, { ticketId: t.ticketId, seq: 1, kind: "backend", title: "partial" });
    const d = await driveUntil(t, atStep("checks:dispatch"), 10);
    expect(d).toMatchObject({ kind: "step", stepKey: "checks:dispatch" });
    expect(t.calls.counts["design:extract"]).toBe(1); // ran once and succeeded
    expect(listUnits(t.db, t.ticketId).map((u) => [u.seq, u.title])).toEqual([
      [1, "Unit 1"],
      [2, "Unit 2"],
    ]);
  },
  STEP_TEST_TIMEOUT_MS,
);
