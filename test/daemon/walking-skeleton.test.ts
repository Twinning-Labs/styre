import { expect, test } from "bun:test";
import { tick } from "../../src/daemon/loop.ts";
import { recover } from "../../src/daemon/recover.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, setStatus as setUnitStatus } from "../../src/db/repos/work-unit.ts";
import { insertPending, markRunning } from "../../src/db/repos/workflow-step.ts";
import { deliverSignal } from "../../src/engine/signals.ts";
import { makeTestDb } from "../helpers/db.ts";

/** Mock handlers that write exactly the state a real handler would, so the resolver
 *  can route a fast-track ticket design→released. No real dispatch/verify/projector. */
function skeletonRegistry(): StepRegistry {
  const r = new StepRegistry();
  r.register("design:dispatch", () => ({ plan: "ok" }));
  r.register("design:extract", (ctx: HandlerContext) => {
    insertWorkUnit(ctx.db, {
      ticketId: ctx.ticket.id,
      seq: 1,
      kind: "backend",
      verifyCheckTypes: ["test"],
    });
    setTicketTrack(ctx.db, ctx.ticket.id, "fast");
    return { units: 1 };
  });
  r.register("implement:dispatch", (ctx: HandlerContext) => {
    if (ctx.workUnitId !== null) {
      setUnitStatus(ctx.db, ctx.workUnitId, "verifying");
    }
    return { code: "ok" };
  });
  r.register("verify:check", (ctx: HandlerContext) => {
    const check = ctx.step.step_key.split(":").pop() ?? "test";
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: check,
      result: "pass",
    });
    return { check };
  });
  r.register("verify:integration", (ctx: HandlerContext) => {
    insertSignal(ctx.db, { ticketId: ctx.ticket.id, signalType: "integration", result: "pass" });
    return { integration: "pass" };
  });
  r.register("review", () => ({ findings: 0 }));
  r.register("merge:push", () => ({ sha: "abc123" }));
  r.register("merge:pr-ensure", () => ({ pr: 1 }));
  r.register("released:project", () => ({ released: true }));
  return r;
}

// Drive via the loop: tick until the ticket is done; when the loop goes idle (the ticket
// parked on a signal, so it left v_ready_tickets), deliver the pending signal via the
// signals engine — simulating the checks poll + human merge. deliverSignal sets the signal
// 'delivered' AND the ticket back to 'active', so v_ready_tickets re-includes it next tick.
async function driveToDone(
  db: Parameters<typeof tick>[0],
  registry: StepRegistry,
  ticketId: number,
  maxTicks = 200,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (getTicket(db, ticketId)?.status === "done") {
      return;
    }
    const summary = await tick(db, registry, { maxConcurrent: 2 });
    if (summary.advanced === 0) {
      const pending = listPending(db, ticketId);
      const first = pending[0];
      if (!first) {
        throw new Error(
          `stuck: ticket idle at stage ${getTicket(db, ticketId)?.stage}, no pending signal`,
        );
      }
      deliverSignal(db, first.id); // un-park: signal delivered + ticket active
    }
  }
  throw new Error("driveToDone: exceeded maxTicks");
}

test("walking skeleton: a fast-track ticket flows design → released", async () => {
  const { db, ticketId } = makeTestDb();
  await driveToDone(db, skeletonRegistry(), ticketId);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.stage).toBe("released");
  expect(ticket?.status).toBe("done");
});

test("crash-resume: a step left running is recovered and the ticket still completes", async () => {
  const { db, ticketId } = makeTestDb();
  // Simulate a crash mid-first-step: design:dispatch left 'running' with a dead pid.
  const crashed = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  markRunning(db, crashed.id, { pid: 999999 });
  // Recovery (M1) resets running → pending after killing the orphan.
  const result = recover(db, { isAlive: () => false, kill: () => {} });
  expect(result.reset).toBe(1);
  // The loop now drives the recovered ticket to completion.
  await driveToDone(db, skeletonRegistry(), ticketId);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.status).toBe("done");
});
