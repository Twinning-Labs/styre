import { afterEach, expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { currentStepKey, setCurrentStep } from "../../src/daemon/current-step.ts";
import { readWorkUnitsForDesign } from "../../src/daemon/design-reads.ts";
import {
  type HandlerContext,
  type StepHandler,
  StepRegistry,
} from "../../src/daemon/step-registry.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import {
  type DesignTicket,
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

// An invariant violation inside a step is a Styre defect, not a transient failure: the failure
// policy escalates it at once, on attempt 1, with its message as the reason. A retry would only
// repeat the defect, and its agent calls. Ordinary failures (retried) and prerequisite failures
// (escalated with the step's signature) keep their own rules; current-step.test.ts and
// failure-policy.test.ts cover them.

afterEach(() => setCurrentStep(null));

/** The real registry, with `handlerKey`'s handler replaced by `override`, which may call the real
 *  one. Commits stay the real ones. */
class OverrideRegistry extends StepRegistry {
  constructor(
    private readonly real: StepRegistry,
    private readonly handlerKey: string,
    private readonly override: (real: StepHandler, ctx: HandlerContext) => unknown,
  ) {
    super(real.synchronize);
  }
  override resolve(handlerKey: string) {
    const h = this.real.resolve(handlerKey);
    if (!h || handlerKey !== this.handlerKey) return h;
    return (ctx: HandlerContext) => this.override(h, ctx);
  }
  override resolveCommit(handlerKey: string) {
    return this.real.resolveCommit(handlerKey);
  }
}

async function step(t: DesignTicket) {
  const outcome = await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
  await pendingLeftoverChecks();
  return outcome;
}

/** Escalated on attempt 1: the step stays failed (a retry would reset it to pending), the ticket
 *  waits on one human_resume signal whose reason carries the violation's message. */
function expectEscalatedAtOnce(t: DesignTicket, stepKey: string, message: string): void {
  const s = getByKey(t.db, t.ticketId, stepKey);
  expect(s?.status).toBe("failed");
  expect(s?.attempt).toBe(1);
  expect(JSON.parse(s?.error_json ?? "{}")).toMatchObject({ invariant: true });
  expect(JSON.parse(s?.error_json ?? "{}").message).toContain(message);
  expect(getTicket(t.db, t.ticketId)?.status).toBe("waiting");
  const resume = listPending(t.db, t.ticketId).filter((x) => x.signal_type === "human_resume");
  expect(resume).toHaveLength(1);
  expect(resume[0]?.reason).toContain(message);
  expect(resume[0]?.reason).not.toContain("exhausted");
}

test(
  "a design handler that reads an undeclared output escalates on attempt 1, before any agent call",
  async () => {
    const base = makeDesignTicket();
    // design:dispatch does not declare workUnits; this handler reads them through the accessor
    const registry = new OverrideRegistry(base.registry, "design:dispatch", (real, ctx) => {
      readWorkUnitsForDesign(ctx.db, ctx.ticket.id);
      return real(ctx);
    });
    const t = { ...base, registry };
    await driveUntil(t, atStep("design:dispatch"));
    expect(await step(t)).toEqual({ kind: "escalated", stepKey: "design:dispatch" });
    expectEscalatedAtOnce(
      t,
      "design:dispatch",
      "design:dispatch reads workUnits, which the design table does not declare for it",
    );
    expect(base.calls.counts["design:dispatch"]).toBe(0);
    expect(currentStepKey()).toBeNull();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a design step whose result is malformed escalates on attempt 1, with one agent call and nothing written",
  async () => {
    const base = makeDesignTicket({ config: { complexityGrading: true } });
    // the real handler runs (one grader call); its result then loses its shape
    const registry = new OverrideRegistry(base.registry, "design:size", async (real, ctx) => ({
      ...((await real(ctx)) as object),
      track: "huge",
    }));
    const t = { ...base, registry };
    await driveUntil(t, atStep("design:size"));
    expect(await step(t)).toEqual({ kind: "escalated", stepKey: "design:size" });
    expectEscalatedAtOnce(t, "design:size", "design:size: the step's result is malformed:");
    expect(base.calls.counts["design:size"]).toBe(1);
    expect(getTicket(t.db, t.ticketId)?.track).toBeNull();
    expect(listUnits(t.db, t.ticketId)).toHaveLength(2); // design:extract's rows are untouched
  },
  STEP_TEST_TIMEOUT_MS,
);
