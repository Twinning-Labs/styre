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
import { getById, insertPending, markFailed } from "../../src/db/repos/workflow-step.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-rd-"));
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

function depsFor(repo: string, wt: string) {
  return {
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo }),
    repoPath: repo,
    worktreePath: wt,
    branch: "feat/ENG-1",
    timeoutMs: 1000,
  };
}

test("runs the agent, commits its edits (CL-COMMIT), records the dispatch with the standard-tier model", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      timedOut: false,
      costUsd: 0.1,
      tokensIn: 5,
      tokensOut: 2,
    };
  });
  const out = await runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "implement:dispatch",
      template: "implement {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: ({ changed }) => {
        if (!changed) throw new Error("empty diff");
      },
    },
  );
  const rows = listByTicket(db, ticketId);
  db.close();
  expect(out.changed).toBe(true);
  expect(out.sha).toMatch(/^[0-9a-f]{7,40}$/);
  expect(rows[0]?.outcome).toBe("clean-success");
  expect(rows[0]?.model).toBe("claude-sonnet-4-6"); // standard tier via DEFAULT_AGENT_CONFIG
});

test("runAgentDispatch surfaces the agent stdout as output", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-stdout-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature-stdout.ts"), "export const x = 1;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: "MARKER-STDOUT",
      stderr: "",
      timedOut: false,
      costUsd: 0.1,
      tokensIn: 5,
      tokensOut: 2,
    };
  });
  const result = await runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "implement:dispatch",
      template: "implement {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {},
    },
  );
  db.close();
  expect(result.output).toBe("MARKER-STDOUT");
});

test("a CL-PROFILE miss throws before running the agent", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  let ran = false;
  const runner = new FakeAgentRunner(() => {
    ran = true;
    return {
      completed: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const call = runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, join(repo, "..", `wt2-${Date.now()}`)) },
    {
      handlerKey: "implement:dispatch",
      template: "needs {{missing}}",
      vars: {},
      postcondition: () => {},
    },
  );
  await expect(call).rejects.toThrow(/CL-PROFILE|missing/);
  db.close();
  expect(ran).toBe(false);
});

test("a postcondition failure throws and records postcondition-failed", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const call = runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, join(repo, "..", `wt3-${Date.now()}`)) },
    {
      handlerKey: "implement:dispatch",
      template: "implement {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: ({ changed }) => {
        if (!changed) throw new Error("empty diff");
      },
    },
  );
  await expect(call).rejects.toThrow(/empty diff/);
  const rows = listByTicket(db, ticketId);
  db.close();
  expect(rows[0]?.outcome).toBe("postcondition-failed");
});

test("retry-feedback: a prior attempt's error_json is prepended to the retry prompt", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-retry-${Date.now()}`);
  const ctx = ctxFor(db, ticketId);
  markFailed(db, ctx.step.id, new Error("REJECTED: unit seq 3 declares no files_to_touch"));
  const fresh = getById(db, ctx.step.id);
  if (!fresh) throw new Error("step missing after markFailed");
  const ctx2 = { ...ctx, step: fresh };
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  await runAgentDispatch(
    ctx2,
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "design:extract",
      template: "PLAN {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {},
    },
  );
  db.close();
  const promptSeen = runner.inputs[0]?.prompt ?? "";
  expect(promptSeen).toContain("REJECTED: unit seq 3 declares no files_to_touch");
  expect(promptSeen).toContain("previous attempt");
});

test("no retry-feedback on the first attempt (error_json null)", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-noretry-${Date.now()}`);
  const ctx = ctxFor(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  await runAgentDispatch(
    ctx,
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "design:extract",
      template: "PLAN {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {},
    },
  );
  db.close();
  expect(runner.inputs[0]?.prompt ?? "").not.toContain("previous attempt");
});

test("a transport failure records dispatch-failed and does NOT commit", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt4-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    // Write a file to prove worktree changes do not get committed on transport failure
    writeFileSync(join(input.cwd, "should-not-be-committed.ts"), "export const x = 1;\n");
    return {
      completed: false,
      exitCode: null,
      stdout: "",
      stderr: "boom",
      timedOut: true,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const call = runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "implement:dispatch",
      template: "implement {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {
        throw new Error("postcondition must never be reached on transport failure");
      },
    },
  );
  await expect(call).rejects.toThrow(/transport failure|timedOut/);
  const rows = listByTicket(db, ticketId);
  db.close();
  expect(rows[0]?.outcome).toBe("dispatch-failed");
  expect(rows[0]?.branch_head_sha).toBeNull();
});
