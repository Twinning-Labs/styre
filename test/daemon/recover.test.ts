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

test("realRecoverDeps().kill takes down an orphaned agent's whole process group (ENG-476)", async () => {
  const { realRecoverDeps } = await import("../../src/daemon/recover.ts");
  const { existsSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const marker = join(mkdtempSync(join(tmpdir(), "styre-recover-pg-")), "orphan-child-acted.txt");
  // An agent (group leader) whose child would still act after the leader is gone.
  const agent = Bun.spawn(["sh", "-c", `(sleep 1; touch '${marker}') & echo started; wait`], {
    detached: true,
    stdout: "pipe",
  });
  await agent.stdout.getReader().read(); // the child exists before recovery kills (else the probe is blind)
  realRecoverDeps().kill(agent.pid);
  await agent.exited;
  await Bun.sleep(1500);
  expect(existsSync(marker)).toBe(false);
});
