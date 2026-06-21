import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { listByUnit } from "../../src/db/repos/ground-truth-signal.ts";
import {
  getById as getUnit,
  insertWorkUnit,
  setStatus as setUnitStatus,
} from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-vfy-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

/** Build a registry whose profile maps the given check-type commands; FakeAgentRunner is unused
 *  by verify steps but RegistryDeps requires it. */
function registryFor(repo: string, commands: Record<string, string>) {
  return buildDispatchRegistry({
    runner: new FakeAgentRunner(() => ({
      completed: true,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    })),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vfywt-")),
  });
}

/** Put the ticket in implement with one unit already 'verifying' and a worktree present
 *  (verify reads the committed worktree the implement dispatch would have made). */
function seedVerifying(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  projectId: number,
  repo: string,
  _registry: ReturnType<typeof registryFor>,
) {
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  setUnitStatus(db, unit.id, "verifying");
  return unit;
}

test("a passing check records a pass signal (with command) and the step succeeds", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { test: "true" });
  const unit = seedVerifying(db, ticketId, projectId, repo, registry);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const sigs = listByUnit(db, unit.id);
  const step = getByKey(db, ticketId, "verify:wu1:test");
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(sigs[0]?.signal_type).toBe("test");
  expect(sigs[0]?.result).toBe("pass");
  expect(sigs[0]?.command).toBe("true");
  expect(step?.status).toBe("succeeded");
});

test("a failing check records a fail signal and fails the step (→ failure-policy loops the unit back)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { test: "false" });
  const unit = seedVerifying(db, ticketId, projectId, repo, registry);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const sigs = listByUnit(db, unit.id);
  const step = getByKey(db, ticketId, "verify:wu1:test");
  const after = getUnit(db, unit.id);
  db.close();
  expect(["retry", "loopback", "escalated"]).toContain(outcome.kind);
  expect(sigs[0]?.result).toBe("fail");
  expect(step?.status).toBe("pending"); // failure-policy reset
  expect(after?.status).toBe("pending"); // generic verify loopback reset the unit
});

test("a missing profile command records an error signal and fails the step", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, {}); // no 'test' command
  const unit = seedVerifying(db, ticketId, projectId, repo, registry);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const sigs = listByUnit(db, unit.id);
  db.close();
  expect(["retry", "loopback", "escalated"]).toContain(outcome.kind);
  expect(sigs[0]?.result).toBe("error");
});

/** Drive a ticket whose units are all verified to the verify:integration step. */
function seedAllVerified(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  projectId: number,
  repo: string,
) {
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  setUnitStatus(db, unit.id, "verified");
}

test("verify:integration passes when build and test pass, recording an integration signal", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { build: "true", test: "true" });
  seedAllVerified(db, ticketId, projectId, repo);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const step = getByKey(db, ticketId, "verify:integration");
  const sigs = db
    .query(
      "SELECT signal_type, result FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'",
    )
    .all(ticketId) as Array<{ signal_type: string; result: string }>;
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(sigs[0]?.result).toBe("pass");
});

test("verify:integration fails the step when a command fails", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { build: "true", test: "false" });
  seedAllVerified(db, ticketId, projectId, repo);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const sigs = db
    .query(
      "SELECT result FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'",
    )
    .all(ticketId) as Array<{ result: string }>;
  db.close();
  expect(["retry", "loopback", "escalated"]).toContain(outcome.kind);
  expect(sigs[0]?.result).toBe("fail");
});

test("a timed-out check records an error signal (not fail)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  // Build the registry inline with a tiny timeout and a command that sleeps longer.
  const registry = buildDispatchRegistry({
    runner: new FakeAgentRunner(() => ({
      completed: true,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    })),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "sleep 5" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vfywt2-")),
    timeoutMs: 200,
  });
  const unit = seedVerifying(db, ticketId, projectId, repo, registry);

  await advanceOneStep(db, ticketId, registry);
  const sigs = listByUnit(db, unit.id);
  db.close();
  // timedOut || exitCode === null maps to "error", not "fail"
  expect(sigs[0]?.result).toBe("error");
});

test("verify:check stamps the verified commit on the signal", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { test: "true" });
  const unit = seedVerifying(db, ticketId, projectId, repo, registry);
  // record a coding attempt with a known commit for the unit
  const d = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
    workUnitId: unit.id,
  });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "deadbeef" });

  await advanceOneStep(db, ticketId, registry);
  const sig = listByUnit(db, unit.id)[0];
  db.close();
  expect(sig?.result).toBe("pass");
  expect(sig?.branch_head_sha).toBe("deadbeef");
});
