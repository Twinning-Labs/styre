// ENG-485 section 9.1: after a step that dispatched an agent, advanceOneStep starts the leftover
// check in the background. It is not awaited, it never changes the step's result, and it is not
// started for a step that dispatched nothing or while a stop is in progress.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { listByTicket } from "../../src/db/repos/event-log.ts";
import { insertPending, markSucceeded } from "../../src/db/repos/workflow-step.ts";
import * as door from "../../src/util/process/door.ts";
import {
  __setCwdReadersForTests,
  pendingLeftoverChecks,
} from "../../src/util/process/leftovers.ts";
import { probe } from "../../src/util/process/proc-table.ts";
import { nowToken } from "../../src/util/process/proc-table.ts";
import { makeTestDb } from "../helpers/db.ts";
import {
  cleanupFixtures,
  folder,
  isRunning,
  leave,
  marker,
  pastToken,
  until,
} from "../helpers/leftover-fixtures.ts";

function seedProvisionDone(db: ReturnType<typeof makeTestDb>["db"], ticketId: number): void {
  const s = insertPending(db, { ticketId, stepKey: "provision", stepType: "provision" });
  markSucceeded(db, s.id, {});
}

/** What an agent step's handler does to the database: one dispatch row naming the worktree. */
function dispatchIn(ctx: HandlerContext, worktree: string): void {
  insertDispatch(ctx.db, {
    ticketId: ctx.ticket.id,
    dispatchId: `${ctx.ticket.ident}-d${nextSeq(ctx.db, ctx.ticket.id)}`,
    seq: nextSeq(ctx.db, ctx.ticket.id),
    stepId: ctx.step.id,
    worktreePath: worktree,
  });
}

let stderr: string[];
beforeEach(() => {
  door.__resetForTests();
  stderr = [];
  spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(async () => {
  __setCwdReadersForTests(undefined);
  await pendingLeftoverChecks();
  cleanupFixtures();
  door.__resetForTests();
  (process.stderr.write as unknown as { mockRestore(): void }).mockRestore();
});

test("a process the agent step left in its worktree is reported on stderr and in the run's events, and the step is unaffected", async () => {
  const { db, ticketId } = makeTestDb();
  seedProvisionDone(db, ticketId);
  const wt = folder("styre wt ");
  const m = marker();
  const registry = new StepRegistry();
  registry.register("design:dispatch", async (ctx) => {
    dispatchIn(ctx, wt);
    await leave(wt, m); // the agent's `nohup server &`
    return { plan: "ok" };
  });
  const outcome = await advanceOneStep(db, ticketId, registry);
  await until(() => isRunning(m));
  await pendingLeftoverChecks();
  expect(outcome).toEqual({ kind: "stepped", stepKey: "design:dispatch" });
  const line = stderr.find((l) => l.includes(`sleep ${m}`));
  expect(line).toMatch(
    /^styre: the agent left ".*sleep .*" \(pid \d+\) running in the worktree; stop it with: kill \d+ \(if it is not yours\)\n$/,
  );
  const notes = listByTicket(db, ticketId).filter((e) => e.reason === "leftover-check");
  expect(notes).toHaveLength(1);
  expect(notes[0].kind).toBe("note");
  expect(notes[0].payload_json).toContain(`sleep ${m}`);
  // Reported, not stopped.
  const pid = Number(/pid (\d+)/.exec(line ?? "")?.[1]);
  expect(probe(pid).kind).toBe("alive");
  db.close();
});

test("a process that was already running when the step began is not reported", async () => {
  const { db, ticketId } = makeTestDb();
  seedProvisionDone(db, ticketId);
  const wt = folder("styre-wt-");
  const m = marker();
  await leave(wt, m);
  await until(() => isRunning(m));
  await pastToken(nowToken());
  const registry = new StepRegistry();
  registry.register("design:dispatch", (ctx) => {
    dispatchIn(ctx, wt);
    return { plan: "ok" };
  });
  await advanceOneStep(db, ticketId, registry);
  await pendingLeftoverChecks();
  expect(stderr.some((l) => l.includes(`sleep ${m}`))).toBe(false);
  expect(listByTicket(db, ticketId).filter((e) => e.reason === "leftover-check")).toEqual([]);
  db.close();
});

test("the check is not awaited: the step returns while it is still running", async () => {
  const { db, ticketId } = makeTestDb();
  seedProvisionDone(db, ticketId);
  let release: (v: Map<number, string>) => void = () => {};
  let reads = 0;
  __setCwdReadersForTests({
    async: () =>
      new Promise((r) => {
        reads++;
        release = r;
      }),
  });
  const registry = new StepRegistry();
  registry.register("design:dispatch", (ctx) => {
    dispatchIn(ctx, folder("styre-wt-"));
    return { plan: "ok" };
  });
  const outcome = await Promise.race([
    advanceOneStep(db, ticketId, registry),
    Bun.sleep(3000).then(() => "the step waited for the check" as const),
  ]);
  expect(outcome).toEqual({ kind: "stepped", stepKey: "design:dispatch" });
  expect(await until(() => reads === 1)).toBe(true); // it did start, and is still blocked
  let waited = false;
  const pending = pendingLeftoverChecks().then(() => {
    waited = true;
  });
  await Bun.sleep(50);
  expect(waited).toBe(false);
  release(new Map());
  await pending;
  expect(waited).toBe(true);
  db.close();
});

test("a step that dispatched no agent starts no check", async () => {
  const { db, ticketId } = makeTestDb();
  seedProvisionDone(db, ticketId);
  let reads = 0;
  __setCwdReadersForTests({
    async: async () => {
      reads++;
      return new Map();
    },
  });
  const registry = new StepRegistry();
  registry.register("design:dispatch", () => ({ plan: "ok" }));
  await advanceOneStep(db, ticketId, registry);
  await pendingLeftoverChecks();
  expect(reads).toBe(0);
  db.close();
});

test("a failed agent step still gets its check, and its failure handling is unchanged", async () => {
  const { db, ticketId } = makeTestDb();
  seedProvisionDone(db, ticketId);
  let reads = 0;
  __setCwdReadersForTests({
    async: async () => {
      reads++;
      return new Map();
    },
  });
  const registry = new StepRegistry();
  registry.register("design:dispatch", (ctx) => {
    dispatchIn(ctx, folder("styre-wt-"));
    throw new Error("agent crashed");
  });
  const outcome = await advanceOneStep(db, ticketId, registry);
  await pendingLeftoverChecks();
  expect(outcome.kind).toBe("retry");
  expect(reads).toBe(1);
  db.close();
});

test("nothing is started once a stop has begun: the signal handler runs its own check", async () => {
  const { db, ticketId } = makeTestDb();
  seedProvisionDone(db, ticketId);
  let reads = 0;
  __setCwdReadersForTests({
    async: async () => {
      reads++;
      return new Map();
    },
  });
  const registry = new StepRegistry();
  registry.register("design:dispatch", (ctx) => {
    dispatchIn(ctx, folder("styre-wt-"));
    door.beginStopping();
    return { plan: "ok" };
  });
  await expect(advanceOneStep(db, ticketId, registry)).rejects.toThrow(door.RunInterrupted);
  await pendingLeftoverChecks();
  expect(reads).toBe(0);
  db.close();
});

test("one check per worktree, however many agent dispatches the step made", async () => {
  const { db, ticketId } = makeTestDb();
  seedProvisionDone(db, ticketId);
  let reads = 0;
  __setCwdReadersForTests({
    async: async () => {
      reads++;
      return new Map();
    },
  });
  const wt = mkdtempSync(`${folder("styre-parent-")}/`);
  const registry = new StepRegistry();
  registry.register("design:dispatch", (ctx) => {
    dispatchIn(ctx, wt);
    dispatchIn(ctx, wt);
    return { plan: "ok" };
  });
  await advanceOneStep(db, ticketId, registry);
  await pendingLeftoverChecks();
  expect(reads).toBe(1);
  db.close();
});

test("only the dispatches the step itself made count: an earlier step's dispatch starts no check", async () => {
  const { db, ticketId } = makeTestDb();
  seedProvisionDone(db, ticketId);
  let reads = 0;
  __setCwdReadersForTests({
    async: async () => {
      reads++;
      return new Map();
    },
  });
  const registry = new StepRegistry();
  registry.register("design:dispatch", (ctx) => {
    dispatchIn(ctx, folder("styre-wt-"));
    return { plan: "ok" };
  });
  registry.register("design:extract", () => ({ units: 0 }));
  await advanceOneStep(db, ticketId, registry); // an agent step
  await pendingLeftoverChecks();
  expect(reads).toBe(1);
  const next = await advanceOneStep(db, ticketId, registry); // a step with no dispatch of its own
  await pendingLeftoverChecks();
  expect(next.kind).toBe("stepped");
  expect(reads).toBe(1);
  db.close();
});
