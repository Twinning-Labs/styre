import { expect, test } from "bun:test";
import { tick } from "../../src/daemon/loop.ts";
import { recover } from "../../src/daemon/recover.ts";
import type { StepRegistry } from "../../src/daemon/step-registry.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending, markRunning } from "../../src/db/repos/workflow-step.ts";
import { deliverSignal } from "../../src/engine/signals.ts";
import { makeTestDb } from "../helpers/db.ts";
import { skeletonRegistry } from "../helpers/skeleton-registry.ts";

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
