// test/daemon/invalidate-loop.test.ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { captureOtherActiveTickets, captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { invalidateSteps } from "../../src/daemon/invalidate.ts";
import { type StepDescriptor, nextStepKey } from "../../src/daemon/resolver.ts";
import { stoppedAtPlanReviewGate } from "../../src/daemon/review-resume.ts";
import { appendEvent, listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { latestDispatchForStep } from "../../src/db/repos/review-finding.ts";
import { getTicket, insertTicket } from "../../src/db/repos/ticket.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import {
  type DesignTicket,
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

/** A digest that changes on every pass: the stand-in for a defect such as an unstable encoding. */
function unstable(t: DesignTicket, i: number): void {
  captureSnapshot(t.db, t.ticketId, {
    profile: { ...t.profile, promptVars: { stack: "ruby", pass: String(i) } },
    unusableComponents: [],
    nonPrimaryComponents: [],
    config: t.config,
  });
}

/** The walk's answer to a changed promptVars while the count is under the limit. */
const INVALIDATE_DISPATCH: StepDescriptor = {
  kind: "invalidate",
  stepKeys: ["design:dispatch"],
  reason: { cause: "inputs", changed: ["profile.promptVars"] },
};

/** The guard's escalation for design:dispatch, reason and all. */
const LOOP_ESCALATION: Extract<StepDescriptor, { kind: "escalate" }> = {
  kind: "escalate",
  reason:
    "design step 'design:dispatch' keeps finding changed inputs (profile.promptVars) after rerunning; an input digest is unstable",
  signature: "invalidate-loop:design:dispatch",
  stepKey: "design:dispatch",
};

/** `count` inputs invalidations of design:dispatch through the real walk, each one checked as an
 *  invalidation (not the guard) before the steps rerun to checks:dispatch. */
async function invalidateForInputs(t: DesignTicket, from: number, count: number): Promise<void> {
  for (let i = from; i < from + count; i++) {
    unstable(t, i);
    expect(nextStepKey(t.db, t.ticketId)).toEqual(INVALIDATE_DISPATCH);
    await driveUntil(t, atStep("checks:dispatch"));
  }
}

/** The `inputs` invalidations naming `stepKey` (the steps downstream of a rerun plan are
 *  invalidated for inputs too, each in its own note). */
const inputsInvalidations = (t: DesignTicket, stepKey = "design:dispatch") =>
  listEvents(t.db, t.ticketId).filter((e) => {
    if (e.reason !== "invalidated") return false;
    const p = JSON.parse(e.payload_json ?? "{}") as { cause?: string; stepKeys?: string[] };
    return p.cause === "inputs" && (p.stepKeys ?? []).includes(stepKey);
  });

test(
  "a step invalidated for inputs more than three times since the last resume escalates invalidate-loop (§8.14)",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    // three are allowed: each one is an invalidation, checked before it is applied
    await invalidateForInputs(t, 1, 3);
    expect(inputsInvalidations(t)).toHaveLength(3);
    unstable(t, 4);
    expect(nextStepKey(t.db, t.ticketId)).toEqual(LOOP_ESCALATION);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "feedback invalidations do not count toward the guard",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    for (let i = 1; i <= 4; i++) {
      invalidateSteps(t.db, t.ticketId, ["design:dispatch"], { cause: "feedback" });
      await driveUntil(t, atStep("checks:dispatch"));
    }
    unstable(t, 1);
    expect(nextStepKey(t.db, t.ticketId)).toEqual(INVALIDATE_DISPATCH);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "only cause inputs counts: worktree-recreated and manifest-touched invalidations do not",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    for (const cause of ["worktree-recreated", "manifest-touched"] as const) {
      for (let i = 1; i <= 2; i++) {
        invalidateSteps(t.db, t.ticketId, ["design:dispatch"], { cause });
        await driveUntil(t, atStep("checks:dispatch"));
      }
    }
    // four invalidations of design:dispatch, none for inputs: the next one is still allowed
    expect(
      listEvents(t.db, t.ticketId).filter((e) => e.reason === "invalidated").length,
    ).toBeGreaterThanOrEqual(4);
    unstable(t, 1);
    expect(nextStepKey(t.db, t.ticketId)).toEqual(INVALIDATE_DISPATCH);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the count is per step: inputs invalidations of another step do not count for design:dispatch",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    for (let i = 1; i <= 4; i++) {
      invalidateSteps(t.db, t.ticketId, ["design:review"], {
        cause: "inputs",
        changed: ["profile.promptVars"],
      });
      await driveUntil(t, atStep("checks:dispatch"));
    }
    expect(inputsInvalidations(t, "design:review")).toHaveLength(4);
    expect(inputsInvalidations(t)).toEqual([]);
    unstable(t, 1);
    expect(nextStepKey(t.db, t.ticketId)).toEqual(INVALIDATE_DISPATCH);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the count starts again after a resumed event",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    await invalidateForInputs(t, 1, 3);
    // a resume: the earlier run's invalidations no longer count (stated exception: the event
    // marks a restart without a second process)
    appendEvent(t.db, { ticketId: t.ticketId, kind: "resumed", reason: "resume" });
    // the count starts at zero, not off: three more are allowed, and the fourth escalates
    await invalidateForInputs(t, 4, 3);
    unstable(t, 7);
    expect(nextStepKey(t.db, t.ticketId)).toEqual(LOOP_ESCALATION);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the count starts again after a reused-database note, the latest start of the run",
  async () => {
    const t = makeDesignTicket();
    // an earlier start, before any invalidation: the count is taken from the latest one
    appendEvent(t.db, { ticketId: t.ticketId, kind: "resumed", reason: "resume" });
    await driveUntil(t, atStep("checks:dispatch"));
    await invalidateForInputs(t, 1, 3);
    // stated exception: the note's real writer is the reused --db test below
    appendEvent(t.db, {
      ticketId: t.ticketId,
      kind: "note",
      reason: "reused-database",
      payload: { event: "reused-database" },
    });
    unstable(t, 4);
    expect(nextStepKey(t.db, t.ticketId)).toEqual(INVALIDATE_DISPATCH);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a second styre run on a reused --db writes a reused-database note; the first does not",
  async () => {
    const h = new DesignHarness("in-place");
    const dbFile = join(makeTempDir("styre-reuse-loop-"), "reuse.db");
    const notes = () =>
      h.readAt(dbFile, (db, id) =>
        listEvents(db, id).filter((e) => e.reason === "reused-database"),
      );
    expect(await h.fresh({ db: dbFile })).toBe(75);
    expect(notes()).toEqual([]);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    const written = notes();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: "note", reason: "reused-database" });
    expect(JSON.parse(written[0]?.payload_json ?? "null")).toEqual({ event: "reused-database" });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a resume writes a resumed event, never a reused-database note",
  async () => {
    const h = new DesignHarness("in-place");
    expect(await h.fresh()).toBe(75);
    expect(await h.resume()).toBe(75);
    h.read((db, id) => {
      const events = listEvents(db, id);
      expect(events.filter((e) => e.kind === "resumed")).toHaveLength(1);
      expect(events.filter((e) => e.reason === "reused-database")).toEqual([]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

/** Four resumes after the first run, each with an edited promptVars, so each invalidates
 *  design:dispatch for inputs once, through the real `resumed` writer. Without a restart of the
 *  count at each resume, the fourth would escalate. (The same through a reused --db cannot be driven
 *  here: every pause leaves the ticket waiting, and a run on a reused --db does not drive a waiting
 *  ticket, so only a crash leaves one to drive again. The note's writer is tested above, and its
 *  effect on the count with the stated exception.) */
test(
  "four resumes, each with an edited input, never trip the guard: earlier runs' invalidations do not count",
  async () => {
    const h = new DesignHarness("in-place");
    expect(await h.fresh()).toBe(75); // pauses needs_you at checks:dispatch
    for (let i = 1; i <= 4; i++) {
      h.editProfile((p) => {
        p.promptVars = { stack: "ruby", pass: String(i) };
      });
      expect(await h.resume()).toBe(75); // design:dispatch reruns, and the run pauses there again
    }
    h.read((db, id) => {
      const events = listEvents(db, id);
      const dispatchInvalidations = events.filter((e) => {
        if (e.reason !== "invalidated") return false;
        const p = JSON.parse(e.payload_json ?? "{}") as { cause?: string; stepKeys?: string[] };
        return p.cause === "inputs" && (p.stepKeys ?? []).includes("design:dispatch");
      });
      expect(dispatchInvalidations).toHaveLength(4);
      expect(events.filter((e) => e.kind === "resumed")).toHaveLength(4);
      expect(events.filter((e) => e.signature?.startsWith("invalidate-loop:"))).toEqual([]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "another active ticket, prepared at each restart by the shared helper, restarts its count there (ruling 2026-10-10)",
  async () => {
    // `t` stands for another active ticket of a reused database or a checkpoint; the run's own
    // ticket is a second one in the same project. Both a run on a reused --db and a resume prepare
    // the other tickets through captureOtherActiveTickets, which is called here as they call it.
    const t = makeDesignTicket();
    const projectId = getTicket(t.db, t.ticketId)?.project_id ?? -1;
    const own = insertTicket(t.db, { projectId, ident: "ENG-2" });
    expect(own).not.toBe(t.ticketId);
    await driveUntil(t, atStep("checks:dispatch"));
    const restart = (i: number) =>
      captureOtherActiveTickets(t.db, own, {
        profile: { ...t.profile, promptVars: { stack: "ruby", pass: String(i) } },
        unusableComponents: [],
        nonPrimaryComponents: [],
        config: t.config,
      });
    // four restarts, each with a changed input: each is an invalidation, never the guard
    for (let i = 1; i <= 4; i++) {
      restart(i);
      expect(nextStepKey(t.db, t.ticketId)).toEqual(INVALIDATE_DISPATCH);
      await driveUntil(t, atStep("checks:dispatch"));
    }
    expect(inputsInvalidations(t)).toHaveLength(4);
    const notes = (id: number) =>
      listEvents(t.db, id).filter((e) => e.reason === "reused-database");
    expect(notes(t.ticketId)).toHaveLength(4);
    expect(notes(own)).toEqual([]);
    // the count runs from the latest restart: one so far, two more allowed, the next escalates
    await invalidateForInputs(t, 5, 2);
    unstable(t, 7);
    expect(nextStepKey(t.db, t.ticketId)).toEqual(LOOP_ESCALATION);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the interpreter escalates the loop to the operator",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    await invalidateForInputs(t, 1, 3);
    unstable(t, 4);
    expect(await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config })).toEqual({
      kind: "escalated",
      stepKey: "design:dispatch",
    });
    await pendingLeftoverChecks();
    expect(getTicket(t.db, t.ticketId)?.status).toBe("waiting");
    const last = listEvents(t.db, t.ticketId).at(-1);
    expect(last).toMatchObject({
      kind: "escalated",
      signature: "invalidate-loop:design:dispatch",
      reason: LOOP_ESCALATION.reason,
    });
    // it carries the latest design:review dispatch, as the interpreter's escalations do, and is
    // still not a stop at the plan review gate (spec §6.4)
    expect(last?.dispatch_id).toMatch(/^ENG-1-d\d+$/);
    expect(last?.dispatch_id).toBe(latestDispatchForStep(t.db, t.ticketId, "design:review"));
    expect(stoppedAtPlanReviewGate(t.db, t.ticketId)).toBe(false);
    // the fourth invalidation was never applied
    expect(inputsInvalidations(t)).toHaveLength(3);
  },
  STEP_TEST_TIMEOUT_MS,
);
