// test/daemon/invalidate.test.ts
import { expect, spyOn, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { CLEAR_OUTPUTS } from "../../src/daemon/design-outputs.ts";
import { invalidateSteps } from "../../src/daemon/invalidate.ts";
import * as resolver from "../../src/daemon/resolver.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import {
  insertFinding,
  listByTicket as listFindings,
  setStatus as setFindingStatus,
} from "../../src/db/repos/review-finding.ts";
import { listStepHistory } from "../../src/db/repos/step-history.ts";
import { getTicket, setNeedsDocs } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { resetProvision, resetProvisionIfManifestTouched } from "../../src/dispatch/provision.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import { unitsOf } from "../helpers/design-script.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

/** A ticket whose design ran for real: two behavioural units, full track, one minor plan finding
 *  tied to unit 1, a reconcile unit, needs_docs set. */
async function designedTicket() {
  const t = makeDesignTicket({
    script: {
      planFindings: () => [
        {
          severity: "minor",
          category: "clarity",
          location: "plan:Unit 1",
          rationale: "name the file",
          factors: null,
          deferral_candidate: false,
          work_unit_seq: 1,
        },
      ],
    },
  });
  await driveUntil(t, atStep("checks:dispatch"));
  insertWorkUnit(t.db, {
    ticketId: t.ticketId,
    seq: 3,
    kind: "reconcile",
    origin: "reconcile",
    dependsOn: [1, 2],
  });
  setNeedsDocs(t.db, t.ticketId, 1);
  return t;
}

test(
  "invalidating design:extract archives, resets, clears every unit and needs_docs, and keeps the plan findings detached",
  async () => {
    const t = await designedTicket();
    const before = getByKey(t.db, t.ticketId, "design:extract");
    const { eventId, generations } = invalidateSteps(t.db, t.ticketId, ["design:extract"], {
      cause: "inputs",
      changed: ["plan"],
    });
    expect(generations).toEqual({ "design:extract": 1 });
    expect(listUnits(t.db, t.ticketId)).toEqual([]); // reconcile unit included
    expect(getTicket(t.db, t.ticketId)?.needs_docs).toBe(0);
    const findings = listFindings(t.db, t.ticketId).filter((f) => f.review_kind === "plan");
    expect(findings.length).toBe(1);
    expect(findings[0].work_unit_id).toBeNull();
    const after = getByKey(t.db, t.ticketId, "design:extract");
    expect(after).toMatchObject({
      status: "pending",
      attempt: 0,
      result_json: null,
      error_json: null,
      input_manifest: null,
      input_fingerprint: null,
      output_digest: null,
      fingerprint_scheme: null,
      generation: 1,
    });
    const [h] = listStepHistory(t.db, t.ticketId, "design:extract");
    expect(h).toMatchObject({
      event_id: eventId,
      status: "succeeded",
      attempt: before?.attempt,
      input_manifest: before?.input_manifest,
      generation: 0,
    });
    const note = listEvents(t.db, t.ticketId).find((e) => e.id === eventId);
    expect(note?.kind).toBe("note");
    expect(note?.reason).toBe("invalidated");
    expect(JSON.parse(note?.payload_json ?? "{}")).toEqual({
      event: "invalidated",
      stepKeys: ["design:extract"],
      cause: "inputs",
      changed: ["plan"],
    });
    expect(listEvents(t.db, t.ticketId).some((e) => e.kind === "loopback")).toBe(false);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:size clears the track; provision, design:dispatch and design:review clear nothing",
  async () => {
    const t = await designedTicket();
    invalidateSteps(t.db, t.ticketId, ["design:size"], { cause: "inputs", changed: ["workUnits"] });
    expect(getTicket(t.db, t.ticketId)?.track).toBeNull();
    const units = listUnits(t.db, t.ticketId).length;
    invalidateSteps(t.db, t.ticketId, ["provision", "design:dispatch", "design:review"], {
      cause: "feedback",
    });
    expect(listUnits(t.db, t.ticketId).length).toBe(units);
    expect(listFindings(t.db, t.ticketId).length).toBe(1);
    for (const k of ["provision", "design:dispatch", "design:review"]) {
      expect(getByKey(t.db, t.ticketId, k)?.generation).toBe(1);
    }
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "resetProvision and the manifest touch hook go through the same function, with their causes",
  async () => {
    const t = await designedTicket();
    resetProvision(t.db, t.ticketId);
    await driveUntil(t, atStep("checks:dispatch")); // provision reruns and succeeds again
    resetProvisionIfManifestTouched(t.db, t.ticketId, ["Gemfile.lock"]);
    const causes = listStepHistory(t.db, t.ticketId, "provision").map((h) => {
      const note = listEvents(t.db, t.ticketId).find((e) => e.id === h.event_id);
      return JSON.parse(note?.payload_json ?? "{}").cause;
    });
    expect(causes).toEqual(["worktree-recreated", "manifest-touched"]);
    expect(getByKey(t.db, t.ticketId, "provision")?.generation).toBe(2);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "only design table steps can be invalidated",
  async () => {
    const t = makeDesignTicket();
    expect(() =>
      invalidateSteps(t.db, t.ticketId, ["checks:dispatch" as never], { cause: "inputs" }),
    ).toThrow("not a design table step");
  },
  STEP_TEST_TIMEOUT_MS,
);

// ---- Beyond the brief's four: the remaining requirements of spec §6 and §6.1. ----

test(
  "the clearing rules run only for the invalidated steps, and the feedback note records no changed inputs",
  async () => {
    const t = await designedTicket();
    const unitsBefore = listUnits(t.db, t.ticketId);
    expect(unitsBefore.length).toBe(3); // two extracted units and the reconcile unit
    const track = getTicket(t.db, t.ticketId)?.track;
    expect(track).not.toBeNull();

    // design:size's rule leaves units, needs_docs and the plan finding's unit link alone.
    invalidateSteps(t.db, t.ticketId, ["design:size"], { cause: "inputs", changed: ["workUnits"] });
    expect(listUnits(t.db, t.ticketId)).toEqual(unitsBefore);
    expect(getTicket(t.db, t.ticketId)?.needs_docs).toBe(1);
    const [finding] = listFindings(t.db, t.ticketId);
    expect(finding.work_unit_id).toBe(unitsBefore[0].id);

    // The rules with nothing to clear touch no unit, finding, track or needs_docs.
    const { eventId } = invalidateSteps(
      t.db,
      t.ticketId,
      ["provision", "design:dispatch", "design:review"],
      { cause: "feedback" },
    );
    expect(listUnits(t.db, t.ticketId)).toEqual(unitsBefore);
    expect(listFindings(t.db, t.ticketId)).toEqual([finding]);
    expect(getTicket(t.db, t.ticketId)?.needs_docs).toBe(1);
    const note = listEvents(t.db, t.ticketId).find((e) => e.id === eventId);
    expect(JSON.parse(note?.payload_json ?? "{}")).toEqual({
      event: "invalidated",
      stepKeys: ["provision", "design:dispatch", "design:review"],
      cause: "feedback",
      changed: [],
    });
    // One note per call, every step of the call archived under it.
    const archived = listStepHistory(t.db, t.ticketId).filter((h) => h.event_id === eventId);
    expect(archived.map((h) => h.step_key)).toEqual([
      "provision",
      "design:dispatch",
      "design:review",
    ]);

    // And design:extract's rule leaves the track alone (it was set again by a rerun of size).
    await driveUntil(t, atStep("checks:dispatch"));
    const rerunTrack = getTicket(t.db, t.ticketId)?.track;
    expect(rerunTrack).not.toBeNull();
    invalidateSteps(t.db, t.ticketId, ["design:extract"], { cause: "inputs", changed: ["plan"] });
    expect(getTicket(t.db, t.ticketId)?.track).toBe(rerunTrack);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:extract detaches every finding tied to a unit, code and plan, whatever its status",
  async () => {
    const t = await designedTicket();
    const [u1, u2] = listUnits(t.db, t.ticketId);
    const [plan] = listFindings(t.db, t.ticketId);
    expect(plan.work_unit_id).toBe(u1.id);
    setFindingStatus(t.db, plan.id, "fixed"); // not open: listOpenByTicket no longer returns it
    const code = insertFinding(t.db, {
      ticketId: t.ticketId,
      reviewKind: "code",
      severity: "major",
      workUnitId: u2.id,
      rationale: "unit 2 code finding",
    });
    invalidateSteps(t.db, t.ticketId, ["design:extract"], { cause: "inputs", changed: ["plan"] });
    const after = listFindings(t.db, t.ticketId);
    expect(after.map((f) => [f.id, f.review_kind, f.status, f.work_unit_id])).toEqual([
      [plan.id, "plan", "fixed", null],
      [code.id, "code", "open", null],
    ]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the history row holds every field the step held, and the reset clears the manifest, fingerprint, digest and scheme",
  async () => {
    const t = await designedTicket();
    const before = getByKey(t.db, t.ticketId, "design:dispatch");
    if (!before) throw new Error("design:dispatch has no row");
    // The plan step records all four, so a field the archive or the reset drops is visible.
    for (const v of [
      before.result_json,
      before.input_manifest,
      before.input_fingerprint,
      before.output_digest,
      before.fingerprint_scheme,
      before.started_at,
      before.ended_at,
    ]) {
      expect(v).not.toBeNull();
    }
    const { eventId, generations } = invalidateSteps(t.db, t.ticketId, ["design:dispatch"], {
      cause: "feedback",
    });
    expect(generations).toEqual({ "design:dispatch": 1 });
    const history = listStepHistory(t.db, t.ticketId, "design:dispatch");
    expect(history.length).toBe(1);
    const h = history[0];
    expect(h).toEqual({
      id: h.id,
      step_id: before.id,
      ticket_id: t.ticketId,
      event_id: eventId,
      step_key: "design:dispatch",
      status: before.status,
      attempt: before.attempt,
      result_json: before.result_json,
      error_json: before.error_json,
      input_manifest: before.input_manifest,
      input_fingerprint: before.input_fingerprint,
      output_digest: before.output_digest,
      fingerprint_scheme: before.fingerprint_scheme,
      generation: 0,
      started_at: before.started_at,
      ended_at: before.ended_at,
      archived_at: h.archived_at,
    });
    expect(h.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getByKey(t.db, t.ticketId, "design:dispatch")).toMatchObject({
      id: before.id,
      status: "pending",
      attempt: 0,
      result_json: null,
      error_json: null,
      pid: null,
      input_manifest: null,
      input_fingerprint: null,
      output_digest: null,
      fingerprint_scheme: null,
      generation: 1,
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a step that failed and waits for its retry is archived with its error and attempt",
  async () => {
    // The first extract returns no units, which validateExtraction rejects; the retry succeeds.
    const t = makeDesignTicket({
      script: { units: (n) => (n === 1 ? [] : unitsOf(2, { behavioral: true })) },
    });
    await driveUntil(
      t,
      (d) =>
        atStep("design:extract")(d) && getByKey(t.db, t.ticketId, "design:extract")?.attempt === 1,
    );
    const before = getByKey(t.db, t.ticketId, "design:extract");
    expect(before?.status).toBe("pending");
    expect(before?.error_json).toContain("extraction has no work units");
    invalidateSteps(t.db, t.ticketId, ["design:extract"], { cause: "feedback" });
    const [h] = listStepHistory(t.db, t.ticketId, "design:extract");
    expect(h).toMatchObject({
      status: "pending",
      attempt: 1,
      error_json: before?.error_json,
      generation: 0,
    });
    expect(getByKey(t.db, t.ticketId, "design:extract")).toMatchObject({
      attempt: 0,
      error_json: null,
      generation: 1,
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a failure anywhere in the invalidation leaves no note, no history row, no reset and no clearing",
  async () => {
    const t = await designedTicket();
    const snapshot = () => ({
      events: listEvents(t.db, t.ticketId),
      history: listStepHistory(t.db, t.ticketId),
      extract: getByKey(t.db, t.ticketId, "design:extract"),
      size: getByKey(t.db, t.ticketId, "design:size"),
      units: listUnits(t.db, t.ticketId),
      findings: listFindings(t.db, t.ticketId),
      ticket: getTicket(t.db, t.ticketId),
    });
    const before = snapshot();
    expect(before.units.length).toBe(3);
    expect(before.ticket?.track).not.toBeNull();
    expect(before.findings[0].work_unit_id).not.toBeNull();
    // design:extract is archived, reset and cleared first; then design:size's rule fails.
    const real = CLEAR_OUTPUTS["design:size"];
    let caught: unknown = null;
    CLEAR_OUTPUTS["design:size"] = () => {
      throw new Error("injected clearing failure");
    };
    try {
      invalidateSteps(t.db, t.ticketId, ["design:extract", "design:size"], {
        cause: "inputs",
        changed: ["plan"],
      });
    } catch (error) {
      caught = error;
    } finally {
      CLEAR_OUTPUTS["design:size"] = real;
    }
    expect(String(caught)).toContain("injected clearing failure");
    expect(snapshot()).toEqual(before);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a step with no row yet archives nothing and reports no generation, and the note is still written",
  async () => {
    const t = makeDesignTicket();
    expect(getByKey(t.db, t.ticketId, "design:size")).toBeNull();
    const { eventId, generations } = invalidateSteps(t.db, t.ticketId, ["design:size"], {
      cause: "inputs",
      changed: ["workUnits"],
    });
    expect(generations).toEqual({});
    expect(listStepHistory(t.db, t.ticketId)).toEqual([]);
    expect(getByKey(t.db, t.ticketId, "design:size")).toBeNull();
    expect(listEvents(t.db, t.ticketId).find((e) => e.id === eventId)?.reason).toBe("invalidated");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a refused step key writes nothing, even beside valid ones, and the message names it",
  async () => {
    const t = await designedTicket();
    const events = listEvents(t.db, t.ticketId).length;
    const extract = getByKey(t.db, t.ticketId, "design:extract");
    expect(() =>
      invalidateSteps(t.db, t.ticketId, ["design:extract", "checks:classify" as never], {
        cause: "inputs",
      }),
    ).toThrow("invalidateSteps: 'checks:classify' is not a design table step");
    expect(listEvents(t.db, t.ticketId).length).toBe(events);
    expect(listStepHistory(t.db, t.ticketId)).toEqual([]);
    expect(getByKey(t.db, t.ticketId, "design:extract")).toEqual(extract);
    expect(listUnits(t.db, t.ticketId).length).toBe(3);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "advanceOneStep applies an invalidate descriptor and then runs the invalidated step",
  async () => {
    const t = await designedTicket();
    const extractCalls = t.calls.counts["design:extract"];
    // No resolver path returns the descriptor yet (the walk lands later), so the first look
    // returns it; every later look is the real resolver.
    const spy = spyOn(resolver, "nextStepKey").mockImplementationOnce(() => ({
      kind: "invalidate",
      stepKeys: ["design:extract"],
      reason: { cause: "inputs", changed: ["plan"] },
    }));
    let outcome: unknown;
    let looks = 0;
    try {
      outcome = await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
      await pendingLeftoverChecks();
      looks = spy.mock.calls.length; // read before mockRestore, which clears the record
    } finally {
      spy.mockRestore();
    }
    // The injected descriptor, then the real resolver's design:extract.
    expect(looks).toBe(2);
    expect(outcome).toEqual({ kind: "stepped", stepKey: "design:extract" });
    const notes = listEvents(t.db, t.ticketId).filter((e) => e.reason === "invalidated");
    expect(notes.length).toBe(1);
    expect(JSON.parse(notes[0].payload_json ?? "{}")).toMatchObject({
      stepKeys: ["design:extract"],
      cause: "inputs",
      changed: ["plan"],
    });
    expect(listStepHistory(t.db, t.ticketId, "design:extract").map((h) => h.generation)).toEqual([
      0,
    ]);
    // The same pass reran it: a new success in generation 1, with fresh units from extract.
    expect(t.calls.counts["design:extract"]).toBe(extractCalls + 1);
    expect(getByKey(t.db, t.ticketId, "design:extract")).toMatchObject({
      status: "succeeded",
      generation: 1,
    });
    expect(listUnits(t.db, t.ticketId).map((u) => u.origin)).toEqual(["extract", "extract"]);
  },
  STEP_TEST_TIMEOUT_MS,
);
