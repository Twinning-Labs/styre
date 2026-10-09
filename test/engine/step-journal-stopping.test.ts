import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as steps from "../../src/db/repos/workflow-step.ts";
import { ParkSignal } from "../../src/engine/park-signal.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import * as door from "../../src/util/process/door.ts";
import * as timeModule from "../../src/util/time.ts";
import { makeTestDb } from "../helpers/db.ts";

let state: string;
const savedState = process.env.XDG_STATE_HOME;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "styre-journal-"));
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
});
afterEach(() => {
  door.__resetForTests();
  if (savedState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  else process.env.XDG_STATE_HOME = savedState;
  rmSync(state, { recursive: true, force: true });
});

const base = (ticketId: number) => ({ ticketId, stepKey: "s", stepType: "t", effectful: true });

test("while stopping, a step that RETURNS is not recorded and RunInterrupted is thrown", async () => {
  const { db, ticketId } = makeTestDb();
  const p = runStep(db, {
    ...base(ticketId),
    readHead: () => "aaa",
    execute: async () => {
      door.beginStopping();
      return { ok: true };
    },
  });
  await expect(p).rejects.toBeInstanceOf(door.RunInterrupted);
  const row = steps.getByKey(db, ticketId, "s");
  expect(row?.status).toBe("running");
  expect(row?.result_json).toBeNull();
  expect(row?.ended_at).toBeNull();
  // R18: the record stays for the signal handler to read while the door is stopping.
  expect(door.inFlightStep()).toEqual({
    stepId: row?.id as number,
    startedAt: row?.started_at as string,
    ident: String(ticketId),
    headAtStart: "aaa",
    headAtStop: "aaa",
  });
  db.close();
});

test("while stopping, onSucceed (the verdict) is not applied either", async () => {
  const { db, ticketId } = makeTestDb();
  let applied = false;
  await expect(
    runStep(db, {
      ...base(ticketId),
      execute: () => {
        door.beginStopping();
        return 1;
      },
      onSucceed: () => {
        applied = true;
      },
    }),
  ).rejects.toBeInstanceOf(door.RunInterrupted);
  expect(applied).toBe(false);
  db.close();
});

test("while stopping, a step that THROWS an ordinary error is not marked failed", async () => {
  const { db, ticketId } = makeTestDb();
  const p = runStep(db, {
    ...base(ticketId),
    execute: async () => {
      door.beginStopping();
      throw new Error("Baseline execution unavailable");
    },
  });
  await expect(p).rejects.toBeInstanceOf(door.RunInterrupted);
  const row = steps.getByKey(db, ticketId, "s");
  expect(row?.status).toBe("running");
  expect(row?.error_json).toBeNull();
  expect(row?.attempt).toBe(1); // markFailed would also have been the only thing to touch this
  expect(door.inFlightStep()).toMatchObject({ stepId: row?.id, startedAt: row?.started_at });
  db.close();
});

test("while stopping, a ParkSignal is an interruption, not a park", async () => {
  const { db, ticketId } = makeTestDb();
  const p = runStep(db, {
    ...base(ticketId),
    execute: () => {
      door.beginStopping();
      throw new ParkSignal({
        cause: "session-limit",
        resetAt: null,
        dispatchId: "ENG-1-d0001",
        transcript: "",
      });
    },
  });
  await expect(p).rejects.toBeInstanceOf(door.RunInterrupted);
  db.close();
});

test("a stop that began BEFORE the step started: RunInterrupted before markRunning, nothing written (B28)", async () => {
  const { db, ticketId } = makeTestDb();
  const pending = steps.insertPending(db, { ticketId, stepKey: "s", stepType: "t" });
  const before = steps.getById(db, pending.id);
  door.beginStopping();
  let ran = false;
  await expect(
    runStep(db, {
      ...base(ticketId),
      execute: () => {
        ran = true;
        return 1;
      },
    }),
  ).rejects.toBeInstanceOf(door.RunInterrupted);
  expect(ran).toBe(false);
  expect(steps.getById(db, pending.id)).toEqual(before); // still pending, attempt 0, no started_at
  expect(before?.status).toBe("pending");
  expect(door.inFlightStep()).toBeNull(); // nothing was registered
  db.close();
});

test("a stop that began BEFORE a brand new step inserts no row either", async () => {
  const { db, ticketId } = makeTestDb();
  door.beginStopping();
  await expect(runStep(db, { ...base(ticketId), execute: () => 1 })).rejects.toBeInstanceOf(
    door.RunInterrupted,
  );
  expect(steps.getByKey(db, ticketId, "s")).toBeNull();
  db.close();
});

test("the in-flight step survives a stop that ends the step, as the handler needs it (R18 reviewer simulation)", async () => {
  const { db, ticketId } = makeTestDb();
  const snapshots: Array<ReturnType<typeof door.inFlightStep>> = [];
  let handle: door.LaunchHandle | null = null;
  const p = runStep(db, {
    ...base(ticketId),
    ident: "ENG-5",
    readHead: () => "start",
    execute: async () => {
      door.noteHead("moved");
      handle = door.launch({
        argv: ["sleep", "30"],
        cwd: process.cwd(),
        env: process.env,
        kind: "agent",
        context: { ident: null, stepId: null, worktree: null },
      });
      // What launchAgent does when its subprocess ends because the handler stopped it.
      await handle.proc.exited;
      throw new door.RunInterrupted();
    },
  });
  const settled = p.then(
    () => null,
    (e: unknown) => e,
  ); // observed at once, so the rejection is never unhandled while the handler awaits the stop
  // The signal handler: close the door, snapshot, stop the launch, then look again.
  while (handle === null) await Bun.sleep(5);
  const h = handle as door.LaunchHandle;
  door.beginStopping();
  snapshots.push(door.inFlightStep()); // step 1
  await h.stop("graceful");
  expect(await settled).toBeInstanceOf(door.RunInterrupted);
  snapshots.push(door.inFlightStep()); // step 6, after runStep unwound
  const row = steps.getByKey(db, ticketId, "s");
  for (const snap of snapshots) {
    expect(snap).toEqual({
      stepId: row?.id as number,
      startedAt: row?.started_at as string,
      ident: "ENG-5",
      headAtStart: "start",
      headAtStop: "moved",
    });
  }
  expect(row?.status).toBe("running");
  db.close();
});

test("outside a stop, an ordinary error still marks the step failed and is rethrown unchanged", async () => {
  const { db, ticketId } = makeTestDb();
  const boom = new Error("boom");
  await expect(
    runStep(db, {
      ...base(ticketId),
      execute: () => {
        throw boom;
      },
    }),
  ).rejects.toBe(boom);
  expect(steps.getByKey(db, ticketId, "s")?.status).toBe("failed");
  expect(door.inFlightStep()).toBeNull(); // cleared on a throw too
  db.close();
});

test("outside a stop, a ParkSignal leaves the step running and is rethrown (park path unchanged)", async () => {
  const { db, ticketId } = makeTestDb();
  const park = new ParkSignal({
    cause: "session-limit",
    resetAt: null,
    dispatchId: "ENG-1-d0001",
    transcript: "",
  });
  await expect(
    runStep(db, {
      ...base(ticketId),
      execute: () => {
        throw park;
      },
    }),
  ).rejects.toBe(park);
  expect(steps.getByKey(db, ticketId, "s")?.status).toBe("running");
  expect(door.inFlightStep()).toBeNull();
  db.close();
});

test("outside a stop, a successful step records its result and clears the in-flight step", async () => {
  const { db, ticketId } = makeTestDb();
  const out = await runStep(db, { ...base(ticketId), execute: () => ({ ok: 1 }) });
  expect(out.step.status).toBe("succeeded");
  expect(out.result).toEqual({ ok: 1 });
  expect(door.inFlightStep()).toBeNull();
  db.close();
});

test("the in-flight step carries headAtStart and follows noteHead, and is cleared after the step", async () => {
  const { db, ticketId } = makeTestDb();
  let seen: ReturnType<typeof door.inFlightStep> = null;
  await runStep(db, {
    ...base(ticketId),
    readHead: () => "aaa",
    execute: async () => {
      door.noteHead("bbb");
      seen = door.inFlightStep();
      return 1;
    },
  });
  expect(seen).toMatchObject({ headAtStart: "aaa", headAtStop: "bbb" });
  expect(door.inFlightStep()).toBeNull();
  db.close();
});

test("headAtStart is read BEFORE execute runs", async () => {
  const { db, ticketId } = makeTestDb();
  let head = "before";
  const box: { seen: string | null } = { seen: null };
  await runStep(db, {
    ...base(ticketId),
    readHead: () => head,
    execute: () => {
      head = "after"; // a read taken after the step began would see this
      box.seen = door.inFlightStep()?.headAtStart ?? null;
      return 1;
    },
  });
  expect(box.seen).toBe("before");
  db.close();
});

test("a branch that does not exist yet gives headAtStart null (readHead null, or no readHead)", async () => {
  const { db, ticketId } = makeTestDb();
  const seen: Array<string | null | undefined> = [];
  await runStep(db, {
    ...base(ticketId),
    stepKey: "a",
    readHead: () => null,
    execute: () => {
      seen.push(door.inFlightStep()?.headAtStart);
      return 1;
    },
  });
  await runStep(db, {
    ...base(ticketId),
    stepKey: "b",
    execute: () => {
      seen.push(door.inFlightStep()?.headAtStart);
      return 1;
    },
  });
  expect(seen).toEqual([null, null]);
  db.close();
});

test("the in-flight startedAt equals the row's started_at exactly, and the step id and ident match", async () => {
  const { db, ticketId } = makeTestDb();
  const box: {
    seen: ReturnType<typeof door.inFlightStep>;
    row: steps.WorkflowStepRow | null;
  } = { seen: null, row: null };
  await runStep(db, {
    ...base(ticketId),
    ident: "ENG-77",
    execute: (step) => {
      box.seen = door.inFlightStep();
      box.row = steps.getById(db, step.id);
      return 1;
    },
  });
  expect(box.row?.started_at).not.toBeNull();
  expect(box.seen).toMatchObject({
    stepId: box.row?.id,
    startedAt: box.row?.started_at,
    ident: "ENG-77",
  });
  db.close();
});

test("a retried attempt gets a new started_at that matches its own in-flight record", async () => {
  const { db, ticketId } = makeTestDb();
  await expect(
    runStep(db, {
      ...base(ticketId),
      execute: () => {
        throw new Error("first attempt fails");
      },
    }),
  ).rejects.toThrow("first attempt fails");
  await Bun.sleep(5);
  const box: {
    seen: ReturnType<typeof door.inFlightStep>;
    row: steps.WorkflowStepRow | null;
  } = { seen: null, row: null };
  await runStep(db, {
    ...base(ticketId),
    execute: (step) => {
      box.seen = door.inFlightStep();
      box.row = steps.getById(db, step.id);
      return 1;
    },
  });
  expect(box.row?.attempt).toBe(2);
  expect(box.seen?.startedAt).toBe(box.row?.started_at ?? "missing");
  db.close();
});

test("a pure (not effectful) step is not registered in flight", async () => {
  const { db, ticketId } = makeTestDb();
  let seen: ReturnType<typeof door.inFlightStep> = "unset" as never;
  await runStep(db, {
    ticketId,
    stepKey: "p",
    stepType: "t",
    readHead: () => "aaa",
    execute: () => {
      seen = door.inFlightStep();
      return 1;
    },
  });
  expect(seen).toBeNull();
  db.close();
});

test("runStep no longer journals a pid, while running or afterwards", async () => {
  const { db, ticketId } = makeTestDb();
  let during: number | null | undefined;
  await runStep(db, {
    ...base(ticketId),
    execute: (step) => {
      during = steps.getById(db, step.id)?.pid;
      return 1;
    },
  });
  expect(during).toBeNull();
  expect(steps.getByKey(db, ticketId, "s")?.pid).toBeNull();
  db.close();
});

test("a step stopped mid run keeps a null pid too", async () => {
  const { db, ticketId } = makeTestDb();
  await expect(
    runStep(db, {
      ...base(ticketId),
      execute: () => {
        door.beginStopping();
        return 1;
      },
    }),
  ).rejects.toBeInstanceOf(door.RunInterrupted);
  expect(steps.getByKey(db, ticketId, "s")?.pid).toBeNull();
  db.close();
});

// --- R12: launch names the ticket from the in-flight step ------------------------------------

test("launch fills ident and stepId from the in-flight step when the caller gave none", async () => {
  const { db, ticketId } = makeTestDb();
  let handle: door.LaunchHandle | null = null;
  await runStep(db, {
    ...base(ticketId),
    ident: "ENG-9",
    execute: async (step) => {
      handle = door.launch({
        argv: ["true"],
        cwd: process.cwd(),
        env: process.env,
        kind: "group",
        context: { ident: null, stepId: null, worktree: "/w" },
      });
      await handle.proc.exited;
      await handle.finish();
      expect(handle.record.stepId).toBe(step.id);
      return 1;
    },
  });
  const h = handle as unknown as door.LaunchHandle;
  expect(h.record.ident).toBe("ENG-9");
  expect(h.context.ident).toBe("ENG-9");
  expect(h.context.stepId).toBe(h.record.stepId);
  expect(h.context.worktree).toBe("/w"); // other fields untouched
  db.close();
});

test("launch keeps an explicit context over the in-flight step", async () => {
  door.beginStep({ stepId: 5, startedAt: "t", ident: "ENG-INFLIGHT", headAtStart: null });
  const h = door.launch({
    argv: ["true"],
    cwd: process.cwd(),
    env: process.env,
    kind: "group",
    context: { ident: "ENG-OWN", stepId: 99, worktree: null },
  });
  await h.proc.exited;
  await h.finish();
  expect(h.record.ident).toBe("ENG-OWN");
  expect(h.record.stepId).toBe(99);
});

test("launch with no step in flight leaves ident and stepId null", async () => {
  const h = door.launch({
    argv: ["true"],
    cwd: process.cwd(),
    env: process.env,
    kind: "group",
    context: { ident: null, stepId: null, worktree: null },
  });
  await h.proc.exited;
  await h.finish();
  expect(h.record.ident).toBeNull();
  expect(h.record.stepId).toBeNull();
});

test("an ordinary error that surfaces after the step returned, while stopping, is an interruption, not a failure", async () => {
  const { db, ticketId } = makeTestDb();
  await expect(
    runStep(db, {
      ...base(ticketId),
      execute: () => 1,
      // Past the check after `execute`; a refused write while stopping would look like this.
      onSucceed: () => {
        door.beginStopping();
        throw new Error("attempt to write a readonly database");
      },
    }),
  ).rejects.toBeInstanceOf(door.RunInterrupted);
  const row = steps.getByKey(db, ticketId, "s");
  expect(row?.status).toBe("running"); // not failed, and markSucceeded was rolled back
  expect(row?.error_json).toBeNull();
  db.close();
});

test("the in-flight startedAt is the row's started_at even when the clock moves on (B8)", async () => {
  const { db, ticketId } = makeTestDb();
  // An observable clock: every call returns a later instant than the one before it.
  let tick = 0;
  const clock = spyOn(timeModule, "nowUtc").mockImplementation(() => {
    tick++;
    return `2030-01-01T00:00:00.${String(tick).padStart(3, "0")}Z`;
  });
  try {
    const box: { seen: ReturnType<typeof door.inFlightStep>; row: steps.WorkflowStepRow | null } = {
      seen: null,
      row: null,
    };
    await runStep(db, {
      ...base(ticketId),
      execute: (step) => {
        box.seen = door.inFlightStep();
        box.row = steps.getById(db, step.id);
        return 1;
      },
    });
    expect(box.row?.started_at).toMatch(/^2030-01-01T00:00:00\.\d{3}Z$/); // the seam was in use
    expect(box.seen?.startedAt).toBe(box.row?.started_at as string);
    // Prove the seam can tell the difference: a fresh read is a different value.
    expect(timeModule.nowUtc()).not.toBe(box.row?.started_at as string);
  } finally {
    clock.mockRestore();
  }
  db.close();
});

test("a readHead that throws fails the step (not left running) and clears the in-flight step", async () => {
  const { db, ticketId } = makeTestDb();
  await expect(
    runStep(db, {
      ...base(ticketId),
      readHead: () => {
        throw new Error("cannot read head");
      },
      execute: () => 1,
    }),
  ).rejects.toThrow("cannot read head");
  expect(steps.getByKey(db, ticketId, "s")?.status).toBe("failed");
  expect(door.inFlightStep()).toBeNull();
  db.close();
});
