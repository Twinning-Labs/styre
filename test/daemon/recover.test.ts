import { expect, test } from "bun:test";
import { recover } from "../../src/daemon/recover.ts";
import * as steps from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function fixedDeps(alive: Set<number>) {
  const killed: number[] = [];
  return {
    deps: {
      isAlive: (pid: number) => alive.has(pid),
      kill: (pid: number) => void killed.push(pid),
    },
    killed,
  };
}

test("recover resets a running step to pending and kills its live orphan pid", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
  });
  steps.markRunning(db, step.id, { pid: 5000 });
  const { deps, killed } = fixedDeps(new Set([5000]));

  const result = recover(db, deps);
  const after = steps.getById(db, step.id);
  db.close();

  expect(result.reset).toBe(1);
  expect(result.killed).toBe(1);
  expect(killed).toEqual([5000]);
  expect(after?.status).toBe("pending");
  expect(after?.pid).toBeNull();
});

test("recover resets a running step whose pid is already dead without killing", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "x", stepType: "dispatch" });
  steps.markRunning(db, step.id, { pid: 9999 });
  const { deps, killed } = fixedDeps(new Set()); // 9999 not alive

  const result = recover(db, deps);
  const after = steps.getById(db, step.id);
  db.close();

  expect(result.reset).toBe(1);
  expect(result.killed).toBe(0);
  expect(killed).toEqual([]);
  expect(after?.status).toBe("pending");
});

test("recover leaves succeeded and pending steps untouched", () => {
  const { db, ticketId } = makeTestDb();
  const done = steps.insertPending(db, { ticketId, stepKey: "done", stepType: "dispatch" });
  steps.markSucceeded(db, done.id, { ok: true });
  steps.insertPending(db, { ticketId, stepKey: "todo", stepType: "dispatch" });
  const { deps } = fixedDeps(new Set());

  const result = recover(db, deps);
  const doneAfter = steps.getById(db, done.id);
  db.close();

  expect(result.reset).toBe(0);
  expect(doneAfter?.status).toBe("succeeded");
});
