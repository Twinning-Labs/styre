import { afterEach, expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { currentStepKey, setCurrentStep } from "../../src/daemon/current-step.ts";
import { type HandlerContext, StepRegistry } from "../../src/daemon/step-registry.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import * as door from "../../src/util/process/door.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import type { DesignScript } from "../helpers/design-script.ts";
import {
  type DesignTicket,
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

// spec §3 (E8): advance.ts holds the step in flight in one process wide slot while the step runs,
// so the named accessors can check the read against that step's declared inputs. The slot must name
// the running step inside its handler and be empty again after every way a step can end.

afterEach(() => {
  setCurrentStep(null);
  door.__resetForTests(); // the interrupt case sets the in process stop flag, as a Ctrl-C does
});

/** Wraps the real registry: each handler first records the slot it sees, and `failOn` makes that
 *  step's handler throw before the real one runs (a step failure the journal records). */
class SlotRegistry extends StepRegistry {
  readonly seen: Array<{ handlerKey: string; slot: string | null }> = [];
  constructor(
    private readonly real: StepRegistry,
    private readonly failOn: string | null = null,
  ) {
    super(real.synchronize);
  }
  override resolve(handlerKey: string) {
    const h = this.real.resolve(handlerKey);
    if (!h) return h;
    return (ctx: HandlerContext) => {
      this.seen.push({ handlerKey, slot: currentStepKey() });
      if (handlerKey === this.failOn) throw new Error(`scripted failure of ${handlerKey}`);
      return h(ctx);
    };
  }
  override resolveCommit(handlerKey: string) {
    return this.real.resolveCommit(handlerKey);
  }
}

function ticketWith(
  failOn: string | null = null,
  script: Partial<DesignScript> = {},
): DesignTicket & { slots: SlotRegistry } {
  const t = makeDesignTicket({ script });
  const slots = new SlotRegistry(t.registry, failOn);
  return { ...t, registry: slots, slots };
}

async function step(t: DesignTicket) {
  const outcome = await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
  await pendingLeftoverChecks();
  return outcome;
}

test(
  "the slot names the running step inside its handler and is empty after each success",
  async () => {
    const t = ticketWith();
    const after: Array<string | null> = [];
    for (const key of ["provision", "design:dispatch", "design:extract", "design:size"]) {
      expect(await step(t)).toEqual({ kind: "stepped", stepKey: key });
      after.push(currentStepKey());
    }
    expect(t.slots.seen).toEqual([
      { handlerKey: "provision", slot: "provision" },
      { handlerKey: "design:dispatch", slot: "design:dispatch" },
      { handlerKey: "design:extract", slot: "design:extract" },
      { handlerKey: "design:size", slot: "design:size" },
    ]);
    expect(after).toEqual([null, null, null, null]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the slot is empty after a step whose handler fails",
  async () => {
    const t = ticketWith("design:dispatch");
    await driveUntil(t, atStep("design:dispatch"));
    const outcome = await step(t);
    expect(outcome.kind).toBe("retry");
    expect(getByKey(t.db, t.ticketId, "design:dispatch")?.error_json).toContain(
      "scripted failure of design:dispatch",
    );
    expect(t.slots.seen.at(-1)).toEqual({ handlerKey: "design:dispatch", slot: "design:dispatch" });
    expect(currentStepKey()).toBeNull();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the slot is empty after a step that parks on a session limit",
  async () => {
    const t = ticketWith(null, { parkAt: "design:extract" });
    await driveUntil(t, atStep("design:extract"));
    const outcome = await step(t);
    expect(outcome).toMatchObject({ kind: "parked", stepKey: "design:extract" });
    expect(currentStepKey()).toBeNull();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the slot is empty after a step a stop interrupts (the error propagates)",
  async () => {
    const t = ticketWith(null, { interruptAt: "design:dispatch", interruptOnCall: 1 });
    await driveUntil(t, atStep("design:dispatch"));
    await expect(step(t)).rejects.toBeInstanceOf(door.RunInterrupted);
    expect(getByKey(t.db, t.ticketId, "design:dispatch")?.status).toBe("running");
    expect(currentStepKey()).toBeNull();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a step cannot start while another holds the slot, and the refusal leaves that step's slot alone",
  async () => {
    const t = ticketWith();
    setCurrentStep("design:review"); // a step in flight elsewhere in this process
    await expect(step(t)).rejects.toThrow(
      "provision cannot start while design:review is in flight",
    );
    expect(currentStepKey()).toBe("design:review");
    expect(t.slots.seen).toEqual([]); // the provision handler never ran
    expect(getByKey(t.db, t.ticketId, "provision")).toBeNull(); // nor did the journal start it
  },
  STEP_TEST_TIMEOUT_MS,
);
