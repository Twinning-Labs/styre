import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByUnit } from "../../src/db/repos/ground-truth-signal.ts";
import {
  getById as getUnit,
  insertWorkUnit,
  setStatus as setUnitStatus,
} from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { resolvePythonInterpreter } from "../../src/dispatch/provision.ts";
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

/** A repo like `gitRepo()`, plus a COMMITTED `services/api/MARKER` (module-local marker, absent
 *  at repo root) and a COMMITTED root-level `ROOT_MARKER` (absent under services/api). Used to
 *  prove a command actually ran at a specific cwd — `test -f MARKER` only succeeds when cwd is
 *  `services/api`; `test -f ROOT_MARKER` only succeeds at the worktree root (WO-9 Task 2). */
function gitRepoWithModuleDir(): string {
  const root = gitRepo();
  mkdirSync(join(root, "services", "api"), { recursive: true });
  writeFileSync(join(root, "services", "api", "MARKER"), "x");
  writeFileSync(join(root, "ROOT_MARKER"), "x");
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["add", "-A"]);
  run(["commit", "-m", "add module dir + root marker"]);
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

test("a passing check records a pass signal (with command) and the step succeeds", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  // FakeAgentRunner writes a file so there's a real commit with base_sha set
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vfywt-")),
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch → commits, sets base_sha
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → no throw)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const step = getByKey(db, ticketId, "verify:wu1:test");
  db.close();
  expect(outcome.kind).toBe("stepped");
  const testSig = sigs.find((s) => s.signal_type === "test");
  expect(testSig?.signal_type).toBe("test");
  expect(testSig?.result).toBe("pass");
  expect(testSig?.command).toBe("true");
  expect(step?.status).toBe("succeeded");
});

test("a failing check records an advisory fail signal but the step SUCCEEDS (no throw, no loopback — M4 demotion)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  // FakeAgentRunner writes a file so there's a real commit
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
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "false" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vfywt-")),
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch → commits, sets base_sha
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → no throw)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test → advisory fail, step succeeds
  const sigs = listByUnit(db, unit.id);
  const step = getByKey(db, ticketId, "verify:wu1:test");
  const after = getUnit(db, unit.id);
  db.close();
  expect(outcome.kind).toBe("stepped"); // never throws — the suite verdict is advisory (M4 §8a)
  const testSig = sigs.find((s) => s.signal_type === "test");
  expect(testSig?.result).toBe("fail");
  expect(JSON.parse(testSig?.detail_json ?? "{}").advisory).toBe(true);
  expect(step?.status).toBe("succeeded"); // no failure-policy involvement — routing advances
  expect(after?.status).toBe("verifying"); // unit is NOT bounced back to pending
});

test("an absent check (component has no command for the declared check-type) records an error signal", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  // FakeAgentRunner writes a file; component has only "build", NOT "test" → absent-check error
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
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { build: "true" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-absent-")),
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch → commits, sets base_sha
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → no throw)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test → absent error
  const sigs = listByUnit(db, unit.id);
  db.close();
  expect(["retry", "loopback", "escalated"]).toContain(outcome.kind);
  const testSig = sigs.find((s) => s.signal_type === "test");
  expect(testSig?.result).toBe("error");
  expect(JSON.parse(testSig?.detail_json ?? "{}").reason).toBe("check-absent");
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

  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
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

test("verify:integration records an advisory fail when a command fails, and the step SUCCEEDS (M4 §8c)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { build: "true", test: "false" });
  seedAllVerified(db, ticketId, projectId, repo);

  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  const outcome = await advanceOneStep(db, ticketId, registry);
  const sigs = db
    .query(
      "SELECT result, detail_json FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'",
    )
    .all(ticketId) as Array<{ result: string; detail_json: string }>;
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(sigs[0]?.result).toBe("fail");
  expect(JSON.parse(sigs[0]?.detail_json ?? "{}").advisory).toBe(true);
});

test("a timed-out check records an error signal (not fail)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  // FakeAgentRunner writes a file so implement commits; verify then runs "sleep 5" with 200ms timeout.
  const registry = buildDispatchRegistry({
    runner: new FakeAgentRunner((input) => {
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
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "sleep 5" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vfywt2-")),
    timeoutMs: 200,
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch → commits, sets base_sha
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → sleeps 5s but timeouts at 200ms
  const sigs = listByUnit(db, unit.id);
  db.close();
  // timedOut || exitCode === null maps to "error", not "fail"
  const testSig = sigs.find((s) => s.signal_type === "test");
  expect(testSig?.result).toBe("error");
});

test("verify:check stamps the verified commit on the signal", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  // FakeAgentRunner writes a file so implement:dispatch commits and records a real sha
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-stmp-")),
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch → real commit sha recorded
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const sig = sigs.find((s) => s.signal_type === "test");
  db.close();
  expect(sig?.result).toBe("pass");
  // The sha is a real git commit sha — just check it's non-null and non-empty
  expect(sig?.branch_head_sha).toBeTruthy();
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
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → no throw)
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
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → no throw)
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
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (allowed.ts declared+touched → completed-by-self; also stamps scope_diff over-delivery for sneaky.ts)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test (passes); scope_diff already stamped by completeness, not re-emitted
  const sigs = listByUnit(db, unit.id);
  const scope = sigs.find((s) => s.signal_type === "scope_diff");
  const testSig = sigs.find((s) => s.signal_type === "test");
  db.close();
  expect(outcome.kind).toBe("stepped"); // step succeeded — advisory did NOT fail it
  expect(testSig?.result).toBe("pass");
  expect(scope?.result).toBe("fail");
  expect(JSON.parse(scope?.detail_json ?? "{}").out_of_scope).toEqual(["sneaky.ts"]);
});

// --- WO-9 Task 2: per-component command cwd (Component.dir) at all three verify run sites ---

test("hard-gate: verify:check runs a non-root component's command in its module dir", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepoWithModuleDir();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
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
      components: [
        {
          name: "api",
          kind: "node",
          paths: ["**"],
          dir: "services/api",
          // Only passes when cwd is services/api — proves the run used the module dir, not root.
          commands: { test: "test -f MARKER" },
        },
      ],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-dircwd-")),
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(sigs[0]?.result).toBe("pass");
});

test("hard-gate: a root component (no dir) still runs at the worktree root (no regression)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepoWithModuleDir();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
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
      components: [
        {
          name: "app",
          kind: "node",
          paths: ["**"],
          // no dir → root; only passes at worktree root.
          commands: { test: "test -f ROOT_MARKER" },
        },
      ],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-dircwd-root-")),
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(sigs[0]?.result).toBe("pass");
});

test("advisory sweep: the swept untouched component's command runs in its module dir", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepoWithModuleDir();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  // The coding attempt writes a root-level, unowned, non-inert file (owned by no component's
  // paths), which triggers the advisory sweep over ALL untouched components.
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "unowned.ts"), "export const x = 1;\n");
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
      components: [
        {
          name: "api",
          kind: "node",
          paths: ["services/api/**"], // does NOT match unowned.ts → stays untouched → swept
          dir: "services/api",
          // Only passes when cwd is services/api.
          commands: { test: "test -f MARKER" },
        },
      ],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-sweepdir-")),
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test (sweep only)
  const sigs = db
    .query(
      "SELECT signal_type, result FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'ran-all-unowned'",
    )
    .all(ticketId) as Array<{ signal_type: string; result: string }>;
  db.close();
  expect(outcome.kind).toBe("stepped");
  // If the sweep ran at the wrong cwd (worktree root), "test -f MARKER" would fail and record a
  // ran-all-unowned signal. With the fix (cwd = module dir), the sweep passes — no such signal.
  expect(sigs).toHaveLength(0);
});

test("verify:integration runs a component job in its module dir and a repoCommands job at repo root", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepoWithModuleDir();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  setUnitStatus(db, unit.id, "verified");
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
      components: [
        {
          name: "api",
          kind: "node",
          paths: ["services/api/**"],
          dir: "services/api",
          // Only passes when cwd is services/api.
          commands: { build: "test -f MARKER", test: "true" },
        },
      ],
      repoCommands: { lint: "test -f ROOT_MARKER" }, // repo-wide → must run at worktree root
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-intdir-")),
  });

  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:integration
  const sigs = db
    .query(
      "SELECT signal_type, result FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'",
    )
    .all(ticketId) as Array<{ signal_type: string; result: string }>;
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(sigs[0]?.result).toBe("pass");
});

// --- Task 2: verify:check test-command resolution routes through reuseAwareTestCommand ---

test("verify:check test command for a python component with no ready env falls back to the configured harness unchanged", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo(); // no pyproject.toml / editable install anywhere → never provably "ready"
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature.py"), "x = 1\n");
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
      // kind: "python" + checkType "test" is exactly what reuseAwareTestCommand self-gates on;
      // "tox" here is the "detected harness" that must survive unchanged when reuse isn't proven.
      components: [{ name: "py", kind: "python", paths: ["**"], commands: { test: "tox" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vfy-pynoready-")),
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch → commits, sets base_sha
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test → runs "tox"
  const sigs = listByUnit(db, unit.id);
  db.close();
  // "tox" isn't a real binary here, but the suite verdict is advisory (M4 §8a) — no throw.
  expect(outcome.kind).toBe("stepped");
  const testSig = sigs.find((s) => s.signal_type === "test");
  expect(testSig?.command).toBe("tox");
});

// RUN_LIVE-gated: exercises the real reuse resolver end to end through the handler — a real
// editable pip install (via the existing `provision` step) makes the python env provably ready,
// so verify:check must run pytest directly instead of the configured "false" harness (which would
// fail the step if it ran unchanged — the strongest possible proof the wiring is live, not mocked).
const live = process.env.RUN_LIVE === "1" ? test : test.skip;

live(
  "verify:check: a ready python env resolves the test command to pytest, not the configured harness",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-vfy-pyready-"));
    const interp = resolvePythonInterpreter();
    const pytestCheck = Bun.spawnSync([interp, "-m", "pytest", "--version"]);
    const installedPytest = pytestCheck.exitCode !== 0;
    try {
      const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "t@s.dev"]);
      run(["config", "user.name", "T"]);
      mkdirSync(join(root, "pkg"), { recursive: true });
      writeFileSync(join(root, "pkg", "__init__.py"), "");
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests", "test_x.py"), "def test_x():\n    assert True\n");
      writeFileSync(
        join(root, "setup.py"),
        "from setuptools import setup\nsetup(name='pkg', version='0.0.1', packages=['pkg'])\n",
      );
      run(["add", "-A"]);
      run(["commit", "-m", "init"]);

      const { db, ticketId, projectId } = makeTestDb();
      db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(root, projectId);
      db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
      const unit = insertWorkUnit(db, {
        ticketId,
        seq: 1,
        kind: "backend",
        behavioral: 0,
        verifyCheckTypes: ["test"],
      });
      const runner = new FakeAgentRunner((input) => {
        writeFileSync(join(input.cwd, "pkg", "extra.py"), "X = 1\n");
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
          targetRepo: root,
          components: [
            {
              name: "pkg",
              kind: "python",
              paths: ["**"],
              // "false" would fail the step if it ran unchanged — proves reuse actually replaced it.
              commands: { test: "false" },
              prepare: `${interp} -m pip install --break-system-packages --user pytest && ${interp} -m pip install --break-system-packages --user -e .`,
            },
          ],
        }),
        worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vfywt-pyready-")),
      });

      await advanceOneStep(db, ticketId, registry); // implement:dispatch → commits, sets base_sha
      await advanceOneStep(db, ticketId, registry); // provision → real editable install (env → ready)
      await advanceOneStep(db, ticketId, registry); // completeness:wu1
      const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test → pytest
      const sigs = listByUnit(db, unit.id);
      db.close();
      expect(outcome.kind).toBe("stepped");
      const testSig = sigs.find((s) => s.signal_type === "test");
      expect(testSig?.result).toBe("pass");
      expect(testSig?.command).toBe(`${interp} -m pytest`);
    } finally {
      await Bun.spawn([interp, "-m", "pip", "uninstall", "-y", "--break-system-packages", "pkg"])
        .exited;
      if (installedPytest) {
        await Bun.spawn([
          interp,
          "-m",
          "pip",
          "uninstall",
          "-y",
          "--break-system-packages",
          "pytest",
        ]).exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
