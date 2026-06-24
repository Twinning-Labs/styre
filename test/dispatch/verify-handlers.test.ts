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
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components:
        Object.keys(commands).length > 0
          ? [{ name: "app", kind: "app", paths: ["**"], commands }]
          : [],
    }),
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
    behavioral: 0,
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
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "sleep 5" } }],
    }),
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

test("behavioral unit: green test command but no test in the diff fails with behavioral-no-test", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 1,
    verifyCheckTypes: ["test"],
  });

  // Coding attempt writes a NON-test file; daemon commits it; profile test command always passes.
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-a1-")),
  });

  // implement (writes feature.ts, commits) then verify:check test (true passes, but no test file).
  await advanceOneStep(db, ticketId, registry); // implement
  await advanceOneStep(db, ticketId, registry); // verify:check test → A1 fail
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  if (!sig) throw new Error("no test signal");
  expect(sig.result).toBe("fail");
  expect(JSON.parse(sig.detail_json ?? "{}").reason).toBe("behavioral-no-test");
});

test("behavioral unit: a test file in the diff passes the test check", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 1,
    verifyCheckTypes: ["test"],
  });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
    writeFileSync(join(input.cwd, "feature.test.ts"), "test('x', () => {});\n");
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-a1ok-")),
  });
  await advanceOneStep(db, ticketId, registry); // implement
  await advanceOneStep(db, ticketId, registry); // verify:check test → pass (test file present)
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  expect(sig?.result).toBe("pass");
});

test("scope_diff records an advisory fail for out-of-scope files but does NOT fail the step", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  // Unit declares it will touch only allowed.ts; non-behavioral so A1 doesn't interfere.
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["allowed.ts"],
  });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "allowed.ts"), "export const a = 1;\n");
    writeFileSync(join(input.cwd, "sneaky.ts"), "export const b = 2;\n"); // out of scope
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-sd-")),
  });
  await advanceOneStep(db, ticketId, registry); // implement
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test (passes) + scope_diff advisory
  const sigs = listByUnit(db, unit.id);
  const scope = sigs.find((s) => s.signal_type === "scope_diff");
  const testSig = sigs.find((s) => s.signal_type === "test");
  db.close();
  expect(outcome.kind).toBe("stepped"); // step succeeded — advisory did NOT fail it
  expect(testSig?.result).toBe("pass");
  expect(scope?.result).toBe("fail");
  expect(JSON.parse(scope?.detail_json ?? "{}").out_of_scope).toEqual(["sneaky.ts"]);
});
