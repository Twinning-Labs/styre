import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-sz-"));
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-szwt-")),
  });
}

// design:dispatch succeeded + units present + track null → resolver routes to design:size.
function readyForSize(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  unitCount: number,
) {
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  for (let i = 1; i <= unitCount; i++) {
    insertWorkUnit(db, {
      ticketId,
      seq: i,
      kind: "backend",
      behavioral: 0,
      verifyCheckTypes: ["test"],
    });
  }
}

test("design:size (grader off) sizes by sprawl: 1 unit → fast", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForSize(db, ticketId, 1);
  const runner = new FakeAgentRunner(() => {
    throw new Error("grader off: no agent should be dispatched");
  });
  await advanceOneStep(db, ticketId, registryFor(repo, runner)); // runs design:size
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("fast");
});

test("design:size (grader off) sizes by sprawl: 2 units → full", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForSize(db, ticketId, 2);
  const runner = new FakeAgentRunner(() => {
    throw new Error("grader off: no agent should be dispatched");
  });
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("full");
});

const sidecar = (json: string) => `Grade.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;
const gradeRunner = (overall: number) =>
  new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({ dimensions: { coupling: 0, blast_radius: 0, difficulty: 0 }, overall }),
    ),
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
const ON = {
  config: { ...DEFAULT_RUNTIME_CONFIG, onPlanDefect: "escalate" as const, complexityGrading: true },
};

test("grader on: low overall + 3 units → fast (bidirectional: simple multi-piece)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForSize(db, ticketId, 3);
  await advanceOneStep(db, ticketId, registryFor(repo, gradeRunner(2)), ON);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("fast");
});

test("grader on: high overall + 1 unit → full (the auth-one-file catch)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForSize(db, ticketId, 1);
  await advanceOneStep(db, ticketId, registryFor(repo, gradeRunner(8)), ON);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("full");
});

test("grader on: low overall but 5 units → full (sprawl floor backstop)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForSize(db, ticketId, 5);
  await advanceOneStep(db, ticketId, registryFor(repo, gradeRunner(1)), ON);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("full");
});

test("grader on: absent grade sidecar fails the step (transport failure)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForSize(db, ticketId, 1);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "no block",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner), ON);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBeNull(); // step threw before setting track
});
