import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import { ParkSignal } from "../../src/engine/park-signal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-park-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function ctxFor(db: ReturnType<typeof makeTestDb>["db"], ticketId: number): HandlerContext {
  const step = insertPending(db, {
    ticketId,
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
  });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  return { db, ticket, step, workUnitId: null, config: DEFAULT_RUNTIME_CONFIG };
}

function deps(runner: FakeAgentRunner, repo: string, wt: string) {
  return {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo }),
    repoPath: repo,
    worktreePath: wt,
    branch: "feat/ENG-1",
    timeoutMs: 1000,
  };
}

test("a session-limit cause throws ParkSignal and records dispatch outcome 'parked'", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-${Date.now()}`);
  const runner = new FakeAgentRunner(() => ({
    completed: false,
    exitCode: 1,
    stdout: "partial work so far",
    stderr: "You've hit your session limit · resets 11:10pm",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cause: "session-limit" as const,
    resetAt: "11:10pm",
  }));
  let signal: unknown;
  try {
    await runAgentDispatch(ctxFor(db, ticketId), deps(runner, repo, wt), {
      handlerKey: "implement:dispatch",
      template: "do {{ticket}}",
      vars: { ticket: "ENG-1" },
      postcondition: () => {},
    });
  } catch (e) {
    signal = e;
  }
  expect(signal).toBeInstanceOf(ParkSignal);
  expect((signal as ParkSignal).info.cause).toBe("session-limit");
  expect((signal as ParkSignal).info.transcript).toBe("partial work so far");
  expect(listByTicket(db, ticketId).at(-1)?.outcome).toBe("parked");
  db.close();
});

test("an out-of-credits cause throws ParkSignal and records dispatch outcome 'parked'", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-oc-${Date.now()}`);
  const runner = new FakeAgentRunner(() => ({
    completed: false,
    exitCode: 1,
    stdout: "some partial output",
    stderr: "You are out of credits",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cause: "out-of-credits" as const,
    resetAt: null,
  }));
  let signal: unknown;
  try {
    await runAgentDispatch(ctxFor(db, ticketId), deps(runner, repo, wt), {
      handlerKey: "implement:dispatch",
      template: "do {{ticket}}",
      vars: { ticket: "ENG-1" },
      postcondition: () => {},
    });
  } catch (e) {
    signal = e;
  }
  expect(signal).toBeInstanceOf(ParkSignal);
  expect((signal as ParkSignal).info.cause).toBe("out-of-credits");
  expect(listByTicket(db, ticketId).at(-1)?.outcome).toBe("parked");
  db.close();
});

test("a transient cause still throws a plain Error and records 'dispatch-failed'", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt2-${Date.now()}`);
  const runner = new FakeAgentRunner(() => ({
    completed: false,
    exitCode: 1,
    stdout: "",
    stderr: "segfault",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cause: "transient" as const,
    resetAt: null,
  }));
  let err: unknown;
  try {
    await runAgentDispatch(ctxFor(db, ticketId), deps(runner, repo, wt), {
      handlerKey: "implement:dispatch",
      template: "do {{ticket}}",
      vars: { ticket: "ENG-1" },
      postcondition: () => {},
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ParkSignal);
  expect(listByTicket(db, ticketId).at(-1)?.outcome).toBe("dispatch-failed");
  db.close();
});
