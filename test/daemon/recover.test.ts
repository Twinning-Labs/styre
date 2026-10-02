import { expect, test } from "bun:test";
import { recover } from "../../src/daemon/recover.ts";
import * as steps from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

// recover() kills nothing (ENG-485 section 5.5): the sweep stops orphans from their launch records.
// Interruption matching, the branch reset and the in-place undo are covered in
// test/lifecycle/interruption.test.ts.

test("recover resets a running step to pending", () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
  });
  steps.markRunning(db, step.id, {});

  const result = recover(db);
  const after = steps.getById(db, step.id);
  db.close();

  expect(result).toEqual({ reset: 1, interrupted: 0, warned: 0 });
  expect(after?.status).toBe("pending");
  expect(after?.pid).toBeNull();
});

test("recover leaves succeeded and pending steps untouched", () => {
  const { db, ticketId } = makeTestDb();
  const done = steps.insertPending(db, { ticketId, stepKey: "done", stepType: "dispatch" });
  steps.markSucceeded(db, done.id, { ok: true });
  steps.insertPending(db, { ticketId, stepKey: "todo", stepType: "dispatch" });

  const result = recover(db);
  const doneAfter = steps.getById(db, done.id);
  db.close();

  expect(result.reset).toBe(0);
  expect(doneAfter?.status).toBe("succeeded");
});

test("recover never signals a journaled pid from an older checkpoint, even a live one", async () => {
  const { db, ticketId } = makeTestDb();
  const child = Bun.spawn(["sleep", "30"]);
  try {
    const step = steps.insertPending(db, {
      ticketId,
      stepKey: "implement:dispatch",
      stepType: "dispatch",
    });
    steps.markRunning(db, step.id, { pid: child.pid });
    const lines: string[] = [];
    const result = recover(db, {
      inPlace: false,
      repoPath: "/x",
      branch: "b",
      acceptHead: false,
      warn: (l) => lines.push(l),
    });
    expect(result).toEqual({ reset: 1, interrupted: 0, warned: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`pid ${child.pid}`);
    await Bun.sleep(100); // a signal, had one been sent, would have landed by now
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);
  } finally {
    child.kill("SIGKILL");
    db.close();
  }
});
