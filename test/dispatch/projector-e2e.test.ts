import { expect, test } from "bun:test";
import { tick } from "../../src/daemon/loop.ts";
import { drainOutbox, enqueueStageProjection } from "../../src/daemon/projector.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { enqueue } from "../../src/db/repos/projection-outbox.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

test("a stage advance projects to the issue tracker via the drainer in tick", async () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  const reg = new StepRegistry();
  reg.register("review", () => ({ findings: 0 }));
  // The merge stage tries merge:push + merge:pr-ensure before parking on external_checks wait.
  reg.register("merge:push", () => ({}));
  reg.register("merge:pr-ensure", () => ({}));
  const fake = fakeIssueTracker();
  // tick 1: runs the `review` step (clean verdict → no loopback).
  // tick 2: advance review→merge (enqueues projection in the same tx) then parks on merge steps,
  //         then drainOutbox applies the projection to the fake port.
  await tick(db, reg, { ports: { issueTracker: fake } });
  await tick(db, reg, { ports: { issueTracker: fake } });
  db.close();
  // The review→merge transition projects set_state=in_review and set_labels.
  expect(fake.calls.some((c) => c.method === "setState" && c.args[1] === "in_review")).toBe(true);
  expect(fake.calls.some((c) => c.method === "setLabels")).toBe(true);
});

test("a projection failure for one outbox row does not block drain of others", async () => {
  const { db, ticketId } = makeTestDb();
  const t = getTicket(db, ticketId);
  if (!t) {
    throw new Error("expected seeded ticket");
  }

  // Enqueue two rows: one good (set_state) and one with an unknown op (will throw in applyRow).
  enqueueStageProjection(db, t, "design", "implement"); // enqueues set_state + set_labels
  enqueue(db, {
    ticketId,
    target: "issue_tracker",
    op: "bogus_op_that_throws",
    payload: { marker: "bad" },
    idempotencyKey: `${t.ident}:bogus:1`,
  });

  const fake = fakeIssueTracker();
  // drainOutbox must return without throwing even though one row fails.
  const result = await drainOutbox(db, { issueTracker: fake });
  db.close();

  // The two good rows (set_state + set_labels) were applied; the bad row was not.
  expect(result.sent).toBe(2);
  // Bad row was counted as failed (after hitting retry budget, or bumped — either way no throw).
  // drainOutbox returns without throwing.
  expect(fake.calls.some((c) => c.method === "setState")).toBe(true);
  expect(fake.calls.some((c) => c.method === "setLabels")).toBe(true);
});
