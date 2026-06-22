import { expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { enqueueStageProjection, stageToState } from "../../src/daemon/projector.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { listPending } from "../../src/db/repos/projection-outbox.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { makeTestDb } from "../helpers/db.ts";

test("stageToState maps stages to neutral issue states", () => {
  expect(stageToState("design")).toBe("in_progress");
  expect(stageToState("implement")).toBe("in_progress");
  expect(stageToState("verify")).toBe("in_progress");
  expect(stageToState("review")).toBe("in_review");
  expect(stageToState("merge")).toBe("in_review");
  expect(stageToState("released")).toBe("done");
});

test("enqueueStageProjection enqueues a mapped set_state and a label swap, idempotently", () => {
  const { db, ticketId } = makeTestDb();
  const t = getTicket(db, ticketId);
  if (!t) {
    throw new Error("expected seeded ticket");
  }
  enqueueStageProjection(db, t, "design", "implement");
  enqueueStageProjection(db, t, "design", "implement"); // re-run → no dup (unique keys)
  const rows = listPending(db);
  db.close();
  const ops = rows.map((r) => r.op).sort();
  expect(ops).toEqual(["set_labels", "set_state"]);
  const state = rows.find((r) => r.op === "set_state");
  const labels = rows.find((r) => r.op === "set_labels");
  expect(JSON.parse(state?.payload_json ?? "{}").state).toBe("in_progress"); // implement → in_progress
  expect(JSON.parse(labels?.payload_json ?? "{}")).toEqual({
    add: ["stage:implement"],
    remove: ["stage:design"],
  });
});

test("advancing through advanceOneStep enqueues the projection (integration with the advance tx)", async () => {
  const { db, ticketId } = makeTestDb();
  // Drive a real advance: stage='review' with the `review` step run clean → the resolver advances
  // review→merge. The `review` step is verdict-bearing; with no findings dispatch the verdict is
  // clean, so the next advanceOneStep collapses the resolver's { kind: "advance", review→merge }.
  const reg = new StepRegistry();
  reg.register("review", () => ({ findings: 0 }));
  // The merge stage runs these before parking on the external_checks wait; register them so the
  // second advanceOneStep (which collapses the advance, then walks into merge) parks cleanly.
  reg.register("merge:push", () => ({}));
  reg.register("merge:pr-ensure", () => ({}));
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  await advanceOneStep(db, ticketId, reg); // runs the review step (clean)
  await advanceOneStep(db, ticketId, reg); // advance review→merge enqueues the projection, then parks
  const rows = listPending(db).filter((r) => r.op === "set_state");
  db.close();
  // merge → in_review; the rows came from the REAL advance transaction, not hand-inserted.
  expect(rows.some((r) => JSON.parse(r.payload_json ?? "{}").state === "in_review")).toBe(true);
});
