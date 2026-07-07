import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-h-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function registryFor(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "bun test" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wtroot-")),
  });
}

test("implement:dispatch runs the agent, commits, sets the unit verifying", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "impl.ts"), "export const y = 2;\n");
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

  const outcome = await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const afterUnit = getUnit(db, unit.id);
  const dispatches = listByTicket(db, ticketId);
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(afterUnit?.status).toBe("verifying");
  expect(step?.status).toBe("succeeded");
  expect(dispatches[0]?.model).toBe("claude-sonnet-4-6");
});

test("implement:dispatch with an empty diff succeeds the step (empty-diff gating moved to completeness)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
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
  const outcome = await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const afterUnit = getUnit(db, unit.id);
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  db.close();
  // implement:dispatch no longer has a postcondition on the diff — an empty diff dispatch now
  // succeeds; the plan gate guarantees non-empty declared files, and it is the completeness
  // step's under-delivery disposition (Task 7) that gates on an empty/insufficient diff.
  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(afterUnit?.status).toBe("verifying");
});

test("implement:dispatch escalates to the deep tier after a bounce-back", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  // simulate a prior bounce-back of this unit
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "implement",
    routeTo: "verify:wu1:test",
    signature: "x",
  });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "f.ts"), "export const y=2;\n");
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
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-lbwt-")),
  });

  await advanceOneStep(db, ticketId, registry);
  const dispatches = listByTicket(db, ticketId);
  db.close();
  expect(dispatches.length).toBe(1);
  expect(dispatches[0]?.model).toBe("claude-opus-4-8"); // deep tier (escalated), not the standard sonnet
});

test("design:dispatch passes when the agent writes this ticket's plan", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'design' WHERE id = ?").run(ticketId);
  const ident = db.query<{ ident: string }, [number]>("SELECT ident FROM ticket WHERE id = ?").get(ticketId)!.ident;
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "docs", "plans"), { recursive: true });
    writeFileSync(join(input.cwd, "docs", "plans", `${ident}.md`), `---\nlinear: ${ident}\n---\n# Plan\n`);
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const d = listByTicket(db, ticketId);
  db.close();
  expect(d.at(-1)?.outcome).toBe("clean-success");
});

test("design:dispatch fails the postcondition when no plan for this ticket exists", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'design' WHERE id = ?").run(ticketId);
  const runner = new FakeAgentRunner(() => // writes NO plan
    ({ completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const d = listByTicket(db, ticketId);
  db.close();
  expect(d.at(-1)?.outcome).toBe("postcondition-failed");
});
