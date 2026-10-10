// test/daemon/design-livelock.test.ts
import { expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { nextStepKey } from "../../src/daemon/resolver.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import { unitsOf } from "../helpers/design-script.ts";
import { STEP_TEST_TIMEOUT_MS, makeDesignTicket } from "../helpers/design-steps.ts";

test(
  "§8.6: plan review goes from findings to none and design finishes in a fixed number of steps",
  async () => {
    const t = makeDesignTicket({
      script: {
        units: () => unitsOf(2, { behavioral: false }),
        plan: (n) => `Plan body, version ${n}`,
        planFindings: (n) =>
          n === 1
            ? [
                {
                  severity: "major",
                  category: "completeness",
                  location: "plan:1",
                  rationale: "missing a step",
                  factors: null,
                  deferral_candidate: false,
                  work_unit_seq: null,
                },
              ]
            : [],
      },
    });
    let steps = 0;
    while (getTicket(t.db, t.ticketId)?.stage === "design") {
      expect(nextStepKey(t.db, t.ticketId).kind).not.toBe("escalate");
      await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
      await pendingLeftoverChecks(); // the background check the step started (ENG-485 section 9.1)
      steps++;
      if (steps > 20) throw new Error("design did not finish: livelock");
    }
    // provision, dispatch, extract, size, review (blocks) | dispatch, extract, review (clean),
    // checks:dispatch, checks:classify | the advance to implement, collapsed inline into the call
    // that runs implement:wu1:dispatch. Invalidations collapse inline too: eleven calls.
    expect(steps).toBe(11);
    expect(t.calls.counts["design:dispatch"]).toBe(2);
    expect(t.calls.counts["design:extract"]).toBe(2);
    expect(t.calls.counts["design:review"]).toBe(2);
  },
  STEP_TEST_TIMEOUT_MS,
);
