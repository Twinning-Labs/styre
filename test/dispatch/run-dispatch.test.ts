import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getById, insertPending, markFailed } from "../../src/db/repos/workflow-step.ts";
import { checksScopeFor, implementScope } from "../../src/dispatch/commit-scope.ts";
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
      stdout: '{}\n```styre-sidecar\n{"new_files":["feature.ts"]}\n```',
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
      commitScope: implementScope,
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

test("compose: retry-feedback AND resumeContext carryover both survive (fail→park→resume)", async () => {
  // The load-bearing ${rendered.prompt}→${prompt} chaining fix: with the old code the carryover
  // would re-base on rendered.prompt and DROP the retry-feedback prepend. This is the only case
  // (both prepends present) that observes it — a direct regression guard (T2 review Minor-1).
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-compose-${Date.now()}`);
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
    {
      runner,
      ...depsFor(repo, wt),
      resumeContext: { stepKey: fresh.step_key, transcript: "PRIOR PARTIAL OUTPUT" },
    },
    {
      handlerKey: "design:extract",
      template: "PLAN {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {},
    },
  );
  db.close();
  const promptSeen = runner.inputs[0]?.prompt ?? "";
  expect(promptSeen).toContain("previous attempt was interrupted"); // CARRYOVER present
  expect(promptSeen).toContain("PRIOR PARTIAL OUTPUT"); // resume transcript present
  expect(promptSeen).toContain("REJECTED: unit seq 3 declares no files_to_touch"); // retry-feedback NOT clobbered
  expect(promptSeen).toContain("PLAN ENG-1"); // rendered base present
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
  expect(rows[0]?.outcome).toBe("dispatch-failed");
  expect(rows[0]?.branch_head_sha).toBeNull();
  expect(existsSync(join(wt, "should-not-be-committed.ts"))).toBe(false); // undoAttempt removed it
  db.close();
});

test("scope reject: an undeclared new file → dispatch-failed at preHead, worktree undone, offenders named", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-scope-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "fix.ts"), "export const x = 1;\n"); // legit edit target (new, undeclared)
    writeFileSync(join(input.cwd, "test_bug.py"), "scratch\n"); // undeclared scratch
    return {
      completed: true,
      exitCode: 0,
      stdout: "no sidecar",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const ctx = ctxFor(db, ticketId);
  const preHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
    .stdout.toString()
    .trim();
  const call = runAgentDispatch(
    ctx,
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "implement:dispatch",
      template: "implement {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: implementScope,
      postcondition: () => {},
    },
  );
  await expect(call).rejects.toThrow(/out-of-scope files.*test_bug\.py/);
  const rows = listByTicket(db, ticketId);
  expect(rows[0]?.outcome).toBe("dispatch-failed");
  expect(rows[0]?.branch_head_sha).toBe(preHead);
  expect(existsSync(join(wt, "fix.ts"))).toBe(false); // undoAttempt cleaned the whole attempt
  db.close();
});

test("scratch drawer: styre_scratch/ is swept before judging → not an offender, not committed, note emitted", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-scratch-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "fix.ts"), "export const x = 1;\n"); // declared deliverable
    mkdirSync(join(input.cwd, "pkg", "styre_scratch"), { recursive: true });
    writeFileSync(join(input.cwd, "pkg", "styre_scratch", "repro.py"), "scratch\n"); // undeclared drawer
    return {
      completed: true,
      exitCode: 0,
      stdout: '```styre-sidecar\n{"new_files":["fix.ts"]}\n```',
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const res = await runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "implement:dispatch",
      template: "implement {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: implementScope,
      postcondition: () => {},
    },
  );

  expect(listByTicket(db, ticketId)[0]?.outcome).toBe("clean-success"); // swept, so NOT rejected
  expect(existsSync(join(wt, "pkg", "styre_scratch"))).toBe(false); // drawer gone
  expect(res.changed).toBe(true);
  const committed = Bun.spawnSync(["git", "show", "--name-only", "--format=", "HEAD"], {
    cwd: wt,
  }).stdout.toString();
  expect(committed).toContain("fix.ts");
  expect(committed).not.toContain("repro.py");
  const notes = listEvents(db, ticketId).filter(
    (e) => e.kind === "note" && e.reason?.startsWith("scratch-swept"),
  );
  expect(notes.length).toBe(1);
  expect(JSON.parse(notes[0]?.payload_json ?? "{}").swept).toContain("pkg/styre_scratch");
  db.close();
});

test("read-only stray: logged as an event_log note, dispatch still clean-success (non-gating)", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-ro-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "stray.txt"), "oops\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  await runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "review",
      template: "review {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {},
    },
  ); // no commitScope
  expect(listByTicket(db, ticketId)[0]?.outcome).toBe("clean-success");
  const notes = listEvents(db, ticketId).filter(
    (e) => e.kind === "note" && e.reason?.startsWith("scratch-ignored"),
  );
  expect(notes.length).toBe(1);
  expect(JSON.parse(notes[0]?.payload_json ?? "{}").stray).toContain("stray.txt");
  db.close();
});

test("no-drop across a transport-failure retry: a re-created declared file commits, never dropped", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-retry2-${Date.now()}`);
  const deps = depsFor(repo, wt);
  const stepCtx = ctxFor(db, ticketId); // same step across both attempts
  // Attempt 1: creates helper.ts then transport-fails (no revert in the old world → the bug).
  const run1 = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "helper.ts"), "export const h = 1;\n");
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
  await expect(
    runAgentDispatch(
      stepCtx,
      { runner: run1, ...deps },
      {
        handlerKey: "implement:dispatch",
        template: "t {{ident}}",
        vars: { ident: "ENG-1" },
        commitScope: implementScope,
        postcondition: () => {},
      },
    ),
  ).rejects.toThrow();
  expect(existsSync(join(wt, "helper.ts"))).toBe(false); // undoAttempt removed attempt-1's file
  // Attempt 2 (retry of the same step): re-creates + declares helper.ts → it MUST commit.
  const run2 = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "helper.ts"), "export const h = 2;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: '```styre-sidecar\n{"new_files":["helper.ts"]}\n```',
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const out = await runAgentDispatch(
    stepCtx,
    { runner: run2, ...deps },
    {
      handlerKey: "implement:dispatch",
      template: "t {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: implementScope,
      postcondition: ({ changed }) => {
        if (!changed) throw new Error("dropped!");
      },
    },
  );
  expect(out.changed).toBe(true);
  expect(Bun.spawnSync(["git", "show", "HEAD:helper.ts"], { cwd: wt }).success).toBe(true); // committed, not dropped
  db.close();
});

test("checks support file: an undeclared styre_checks/__init__.py co-located with the canonical check is admitted (ENG-323)", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-support-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "tests", "styre_checks"), { recursive: true });
    writeFileSync(
      join(input.cwd, "tests", "styre_checks", "ENG-1_ac1_test.py"),
      "def test_x():\n    assert False\n",
    );
    writeFileSync(join(input.cwd, "tests", "styre_checks", "__init__.py"), ""); // undeclared marker
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"tests/styre_checks/ENG-1_ac1_test.py","test_name":"test_x"}],"new_files":[]}\n```',
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const res = await runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "checks:dispatch",
      template: "checks {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: checksScopeFor("ENG-1", [1]),
      postcondition: () => {},
    },
  );

  expect(listByTicket(db, ticketId)[0]?.outcome).toBe("clean-success"); // NOT rejected
  expect(res.changed).toBe(true);
  const committed = Bun.spawnSync(["git", "show", "--name-only", "--format=", "HEAD"], {
    cwd: wt,
  }).stdout.toString();
  expect(committed).toContain("tests/styre_checks/ENG-1_ac1_test.py");
  expect(committed).toContain("tests/styre_checks/__init__.py");
  db.close();
});
