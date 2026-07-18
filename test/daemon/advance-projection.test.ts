import { expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { enqueueStageProjection, stageToState } from "../../src/daemon/projector.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
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

test("re-entering a stage across a loopback cycle is NOT suppressed (cycle-epoch keys — codex P2)", () => {
  const { db, ticketId } = makeTestDb();
  const t = getTicket(db, ticketId);
  if (!t) {
    throw new Error("expected seeded ticket");
  }
  // First design→implement transition (its event drives the cycle epoch).
  appendEvent(db, { ticketId, kind: "transition", fromStage: "design", toStage: "implement" });
  enqueueStageProjection(db, t, "design", "implement");
  const afterFirst = listPending(db).filter((r) => r.op === "set_state").length;
  expect(afterFirst).toBe(1);

  // A redesign loopback cycles back to design, then design→implement happens AGAIN. With only a
  // from→to key the second projection would collide with the first and INSERT OR IGNORE would drop
  // it, leaving the external mirror stale. A new stage-change event bumps the epoch → new key.
  appendEvent(db, { ticketId, kind: "loopback", loop: "design", routeTo: "review" });
  appendEvent(db, { ticketId, kind: "transition", fromStage: "design", toStage: "implement" });
  enqueueStageProjection(db, t, "design", "implement");
  const afterSecond = listPending(db).filter((r) => r.op === "set_state").length;
  db.close();
  expect(afterSecond).toBe(2); // the re-entry produced a SECOND set_state row (not suppressed)
});

test("advancing through advanceOneStep enqueues the projection (integration with the advance tx)", async () => {
  const { db, ticketId } = makeTestDb();
  // Drive a real advance: stage='review' with the `review` step run clean → the resolver advances
  // review→merge. The `review` step is verdict-bearing; with no findings dispatch the verdict is
  // clean, so the next advanceOneStep collapses the resolver's { kind: "advance", review→merge }.
  const reg = new StepRegistry();
  reg.register("review", () => ({ findings: 0 }));
  // The merge stage runs these before parking on the human_merge_approval wait; register them so the
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
