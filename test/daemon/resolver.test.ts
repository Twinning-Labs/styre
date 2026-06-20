import { expect, test } from "bun:test";
import { nextStepKey } from "../../src/daemon/resolver.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { insertPending, markDelivered } from "../../src/db/repos/signal.ts";
import { setNeedsDocs, setTicketStage, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

// helper: journal a step straight to succeeded (simulates a completed step for the resolver to read)
async function succeed(db: Parameters<typeof runStep>[0], ticketId: number, stepKey: string) {
  await runStep(db, { ticketId, stepKey, stepType: "dispatch", execute: () => ({ ok: true }) });
}

test("design: first asks for design:dispatch", () => {
  const { db, ticketId } = makeTestDb();
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "design:dispatch",
    stepType: "dispatch",
    handlerKey: "design:dispatch",
    workUnitId: null,
  });
});

test("design: after dispatch with no work units, asks for design:extract", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "design:dispatch");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("design:extract");
});

test("design fast-track: with units + track=fast, advances to implement", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "design:dispatch");
  setTicketTrack(db, ticketId, "fast");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "design", to: "implement" });
});

test("design full-track: with units + track=full, asks for design:review before advancing", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "design:dispatch");
  setTicketTrack(db, ticketId, "full");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("design:review");
});

test("implement: a pending unit asks for its dispatch step", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
    handlerKey: "implement:dispatch",
    workUnitId: expect.any(Number),
  });
});

test("implement: a verifying unit with an unrun check asks for the verify step", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "verify:wu1:test",
    stepType: "verify",
    handlerKey: "verify:check",
    workUnitId: u.id,
  });
});

test("implement: a verifying unit whose checks all have signals asks to mark-verified", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  insertSignal(db, { ticketId, workUnitId: u.id, signalType: "test", result: "pass" });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "mark-verified", workUnitId: u.id });
});

test("implement: all units verified + no docs → verify:integration then advance to review", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  expect(u.status).toBe("verified");
  const beforeIntegration = nextStepKey(db, ticketId);
  expect(beforeIntegration.kind === "step" && beforeIntegration.handlerKey).toBe(
    "verify:integration",
  );
  await succeed(db, ticketId, "verify:integration");
  const afterIntegration = nextStepKey(db, ticketId);
  db.close();
  expect(afterIntegration).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("implement: needs_docs routes through docs:revise before advancing", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  setNeedsDocs(db, ticketId, 1);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  await succeed(db, ticketId, "verify:integration");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("docs:revise");
});

test("review: asks for review then advances to merge", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "review");
  const before = nextStepKey(db, ticketId);
  expect(before.kind === "step" && before.handlerKey).toBe("review");
  await succeed(db, ticketId, "review");
  const after = nextStepKey(db, ticketId);
  db.close();
  expect(after).toEqual({ kind: "advance", from: "review", to: "merge" });
});

test("merge: push → pr-ensure → wait checks → wait human → advance to released", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "merge");
  expect((nextStepKey(db, ticketId) as { handlerKey: string }).handlerKey).toBe("merge:push");
  await succeed(db, ticketId, "merge:push");
  expect((nextStepKey(db, ticketId) as { handlerKey: string }).handlerKey).toBe("merge:pr-ensure");
  await succeed(db, ticketId, "merge:pr-ensure");
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "wait", signalType: "external_checks" });
  const checks = insertPending(db, { ticketId, signalType: "external_checks" });
  markDelivered(db, checks.id);
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "wait", signalType: "human_merge_approval" });
  const human = insertPending(db, { ticketId, signalType: "human_merge_approval" });
  markDelivered(db, human.id);
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "merge", to: "released" });
});

test("released: runs released:project then reports done", async () => {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "released");
  expect((nextStepKey(db, ticketId) as { handlerKey: string }).handlerKey).toBe("released:project");
  await succeed(db, ticketId, "released:project");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "done" });
});
