import { expect, test } from "bun:test";
import * as steps from "../../src/db/repos/workflow-step.ts";
import { idempotencyKey } from "../../src/engine/idempotency.ts";
import { StepInFlightError, runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("a pure step runs once, journals succeeded, and replays its recorded result", async () => {
  const { db, ticketId } = makeTestDb();
  let calls = 0;
  const params = {
    ticketId,
    stepKey: "design:extract",
    stepType: "dispatch",
    execute: () => {
      calls++;
      return { units: 2 };
    },
  };

  const first = await runStep(db, params);
  expect(first.replayed).toBe(false);
  expect(first.result).toEqual({ units: 2 });
  expect(first.step.status).toBe("succeeded");

  // Replay: the resolver re-asks for the same step_key → recorded result, no re-run.
  const second = await runStep(db, params);
  db.close();
  expect(second.replayed).toBe(true);
  expect(second.result).toEqual({ units: 2 });
  expect(calls).toBe(1); // executed exactly once
});

test("an effectful step journals running + idempotency key before the effect", async () => {
  const { db, ticketId } = makeTestDb();
  let observedStatusDuringEffect = "";
  const key = idempotencyKey("ENG-1-d1", "push");
  const result = await runStep(db, {
    ticketId,
    stepKey: "merge:push",
    stepType: "project",
    effectful: true,
    idempotencyKey: key,
    execute: (step) => {
      // The journal must have recorded intent (running + key) BEFORE we run.
      observedStatusDuringEffect = step.status;
      return { sha: "abc" };
    },
  });
  const persisted = steps.getByKey(db, ticketId, "merge:push");
  db.close();
  expect(observedStatusDuringEffect).toBe("running");
  expect(result.step.idempotency_key).toBe(key);
  expect(persisted?.status).toBe("succeeded");
});

test("a failing step is journaled failed and the error rethrown", async () => {
  const { db, ticketId } = makeTestDb();
  const run = runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => {
      throw new Error("agent died");
    },
  });
  await expect(run).rejects.toThrow("agent died");
  const persisted = steps.getByKey(db, ticketId, "design:dispatch");
  db.close();
  expect(persisted?.status).toBe("failed");
  expect(JSON.parse(persisted?.error_json ?? "{}").message).toBe("agent died");
});

test("runStep refuses a step another runner left running", async () => {
  const { db, ticketId } = makeTestDb();
  const step = steps.insertPending(db, { ticketId, stepKey: "merge:push", stepType: "project" });
  steps.markRunning(db, step.id, { pid: 1 });
  const run = runStep(db, {
    ticketId,
    stepKey: "merge:push",
    stepType: "project",
    execute: () => ({}),
  });
  await expect(run).rejects.toBeInstanceOf(StepInFlightError);
  db.close();
});

test("a keyed effect is exactly-once-effective across a crash + recovery re-run", async () => {
  const { db, ticketId } = makeTestDb();
  const key = idempotencyKey("ENG-1-d1", "push");
  // The "external effect" is a keyed outbox insert that dedups on idempotency_key.
  let effectCalls = 0;
  const effect = (): { applied: true } => {
    effectCalls += 1;
    db.query(
      `INSERT INTO projection_outbox (ticket_id, target, op, idempotency_key, status, created_at)
       VALUES ($t, 'forge', 'push', $key, 'pending', $now)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run({ $t: ticketId, $key: key, $now: new Date().toISOString() });
    return { applied: true };
  };

  // First attempt completes the effect, then we simulate a crash AFTER the effect
  // but treat the step as interrupted by forcing it back to 'running'.
  await runStep(db, {
    ticketId,
    stepKey: "merge:push",
    stepType: "project",
    effectful: true,
    idempotencyKey: key,
    execute: effect,
  });
  const stepRow = steps.getByKey(db, ticketId, "merge:push");
  if (!stepRow) throw new Error("step not found after first run");
  steps.markRunning(db, stepRow.id, { idempotencyKey: key, pid: 1 }); // pretend it crashed mid-step

  // Recovery resets it to pending; the resolver re-runs the same keyed effect.
  steps.resetToPending(db, stepRow.id);
  await runStep(db, {
    ticketId,
    stepKey: "merge:push",
    stepType: "project",
    effectful: true,
    idempotencyKey: key,
    execute: effect,
  });

  const count = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM projection_outbox WHERE idempotency_key = ?",
    )
    .get(key);
  db.close();
  expect(effectCalls).toBe(2); // at-least-once-attempted: effect was invoked on both runs
  expect(count?.n).toBe(1); // exactly-once-effective: keyed insert applied only once
});
