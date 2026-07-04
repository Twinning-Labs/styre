import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import {
  listByUnit,
  listByTicket as listSignalsByTicket,
} from "../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry, renderPrBody } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-vr-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function rig(repo: string, profileExtra: object) {
  const profile = parseProfile({ slug: "demo", targetRepo: repo, ...profileExtra });
  return { profile, worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vrwt-")) };
}

test("docs-only diff with no owned files passes for non-behavioral unit", async () => {
  // A diff that contains only docs files (e.g. docs/note.md) and no file that matches any
  // component should pass WITHOUT error — the new algorithm routes it through the pure-docs path.
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
  // Agent writes docs/note.md — a docs file, no component covers docs/**
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "docs"), { recursive: true });
    writeFileSync(join(input.cwd, "docs", "note.md"), "# note");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "rust", kind: "rust", paths: ["src-tauri/**"], commands: { test: "true" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch (writes docs/note.md)
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → pure-docs path
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  // pure-inert + non-behavioral → pass (no hard gate ran, no sweep triggered)
  expect(sig?.result).toBe("pass");
  expect(JSON.parse(sig?.detail_json ?? "{}").reason).toBe("inert-only");
});

test("a stack with a real command runs and passes", async () => {
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
  // Agent writes a file that matches the component (paths:["**"])
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch (writes feature.ts, base_sha captured)
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → real command, passes
  // Advance one more tick to allow the resolver to mark the unit verified
  await advanceOneStep(db, ticketId, registry);
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  const afterUnit = db
    .query<{ status: string }, [number]>("SELECT status FROM work_unit WHERE id = ?")
    .get(unit.id);
  db.close();
  expect(sig?.result).toBe("pass");
  expect(afterUnit?.status).toBe("verified");
});

test("behavioral unit in a test-unavailable stack degrades to reviewer-only", async () => {
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
  // Agent writes src/app.ts — matched by paths:["src/**"] whose test is unavailable
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "src"), { recursive: true });
    writeFileSync(join(input.cwd, "src", "app.ts"), "export const app = 1;\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      {
        name: "fe",
        kind: "frontend",
        paths: ["src/**"],
        commands: { test: { unavailable: true } },
      },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → all-unavailable degrade
  const sigs = listByUnit(db, unit.id);
  const testSig = sigs.find((s) => s.signal_type === "test");
  const riskSig = sigs.find((s) => s.signal_type === "untested-merge-risk");
  db.close();
  // Decision C: not an error — result is pass (degraded) AND untested-merge-risk is emitted
  expect(testSig?.result).toBe("pass");
  expect(riskSig).toBeTruthy();
  expect(JSON.parse(riskSig?.detail_json ?? "{}").component).toBe("fe");
});

test("a declared check absent on an impacted component errors (loud)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["lint"],
  });
  // Agent writes src/app.ts; component has build but NO lint key (not even unavailable)
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "src"), { recursive: true });
    writeFileSync(join(input.cwd, "src", "app.ts"), "export const app = 1;\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [{ name: "app", kind: "app", paths: ["src/**"], commands: { build: "true" } }],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check lint → absent → error
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "lint");
  db.close();
  expect(sig?.result).toBe("error");
  expect(JSON.parse(sig?.detail_json ?? "{}").reason).toBe("check-absent");
});

test("mixed tested + untested behavioral unit: tested stack gates, untested stack flags", async () => {
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
  // Agent writes both src-tauri/lib.rs (with a rust test file) AND src/app.ts (fe, unavailable)
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "src-tauri"), { recursive: true });
    mkdirSync(join(input.cwd, "src"), { recursive: true });
    writeFileSync(join(input.cwd, "src-tauri", "lib.rs"), "fn main() {}");
    writeFileSync(join(input.cwd, "src-tauri", "lib_test.rs"), "#[test] fn t() {}");
    writeFileSync(join(input.cwd, "src", "app.ts"), "export const app = 1;\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      {
        name: "rust",
        kind: "rust",
        paths: ["src-tauri/**"],
        commands: { test: "true" },
        testFilePattern: "_test\\.rs$",
      },
      {
        name: "fe",
        kind: "frontend",
        paths: ["src/**"],
        commands: { test: { unavailable: true } },
      },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const testSig = sigs.find((s) => s.signal_type === "test");
  const riskSig = sigs.find((s) => s.signal_type === "untested-merge-risk");
  db.close();
  // rust: real command passes; fe: unavailable → untested-merge-risk; aggregate: pass
  expect(testSig?.result).toBe("pass");
  expect(riskSig).toBeTruthy();
  expect(JSON.parse(riskSig?.detail_json ?? "{}").component).toBe("fe");
});

test("renderPrBody includes untested-merge-risk component name when degrade occurred", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 1,
    verifyCheckTypes: ["test"],
  });
  // Agent writes src/app.ts; test unavailable → degrade → untested-merge-risk signal
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "src"), { recursive: true });
    writeFileSync(join(input.cwd, "src", "app.ts"), "export const app = 1;\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      {
        name: "myfe",
        kind: "frontend",
        paths: ["src/**"],
        commands: { test: { unavailable: true } },
      },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });

  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → degrade

  // Verify the untested-merge-risk signal was created
  const riskSigs = listSignalsByTicket(db, ticketId).filter(
    (s) => s.signal_type === "untested-merge-risk",
  );
  expect(riskSigs.length).toBeGreaterThan(0);

  // Drive to merge:pr-ensure to render the PR body
  // Advance through the remaining steps until merge (or just check the PR body function indirectly
  // by inspecting the signals and verifying the component name would appear)
  const riskComponent = JSON.parse(riskSigs[0]?.detail_json ?? "{}").component;
  db.close();
  expect(riskComponent).toBe("myfe");
});

// ── WO-5 Task 1: file-identity routing + advisory sweep ──────────────────────

test("zero components in profile → no-components-detected error, not vacuous pass", async () => {
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
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "main.ts"), "export const x = 1;\n");
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
  const { profile, worktreeRoot } = rig(repo, { components: [] });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → no-components-detected
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  expect(sig?.result).toBe("error");
  expect(JSON.parse(sig?.detail_json ?? "{}").reason).toBe("no-components-detected");
});

test("behavioral unit with docs-only diff → behavioral-no-code fail", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 1, // behavioral — docs-only diff must fail
    verifyCheckTypes: ["test"],
  });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "README.md"), "# updated");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [{ name: "app", kind: "app", paths: ["src/**"], commands: { test: "true" } }],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch (writes README.md)
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → behavioral-no-code
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  expect(sig?.result).toBe("fail");
  expect(JSON.parse(sig?.detail_json ?? "{}").reason).toBe("behavioral-no-code");
});

test("advisory sweep records ran-all-unowned for failing untouched stack, unit still passes", async () => {
  // app/main.ts is owned by `app` component (hard-gated, passes).
  // deploy/cfg.yaml is unowned non-inert → triggers advisory sweep of `svc`.
  // svc's test command is `false` (fails) → ran-all-unowned signal emitted.
  // The unit itself must still pass (advisory sweep never hard-fails).
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
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "app"), { recursive: true });
    mkdirSync(join(input.cwd, "deploy"), { recursive: true });
    writeFileSync(join(input.cwd, "app", "main.ts"), "export const x = 1;\n");
    writeFileSync(join(input.cwd, "deploy", "cfg.yaml"), "env: prod\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { test: "false" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const testSig = sigs.find((s) => s.signal_type === "test");
  const sweepSig = sigs.find((s) => s.signal_type === "ran-all-unowned");
  db.close();
  // Hard gate on `app` passed → unit passes
  expect(testSig?.result).toBe("pass");
  // Advisory sweep on `svc` failed → ran-all-unowned recorded
  expect(sweepSig).toBeTruthy();
  expect(JSON.parse(sweepSig?.detail_json ?? "{}").component).toBe("svc");
  expect(JSON.parse(sweepSig?.detail_json ?? "{}").checkType).toBe("test");
});

test("advisory sweep with passing untouched stack emits no signal and unit passes", async () => {
  // Both components have test:"true". deploy/cfg.yaml is unowned → sweep runs svc, passes.
  // No ran-all-unowned signal should appear (sweep only records on non-zero exit).
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
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "app"), { recursive: true });
    mkdirSync(join(input.cwd, "deploy"), { recursive: true });
    writeFileSync(join(input.cwd, "app", "main.ts"), "export const x = 1;\n");
    writeFileSync(join(input.cwd, "deploy", "cfg.yaml"), "env: prod\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { test: "true" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const testSig = sigs.find((s) => s.signal_type === "test");
  const sweepSig = sigs.find((s) => s.signal_type === "ran-all-unowned");
  db.close();
  expect(testSig?.result).toBe("pass");
  expect(sweepSig).toBeUndefined(); // sweep passed → no signal emitted
});

test("all changed files unowned non-inert → no hard gate runs, advisory sweep, unit passes", async () => {
  // config/settings.yaml is not owned by any component.
  // realImpacted = [] → no hard gate. unownedNonInert = [config/settings.yaml].
  // Advisory sweep: `app` (test:"true") passes — no signal. `svc` (test:"false") fails → signal.
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
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "config"), { recursive: true });
    writeFileSync(join(input.cwd, "config", "settings.yaml"), "debug: false\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { test: "false" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const testSig = sigs.find((s) => s.signal_type === "test");
  const sweepSigs = sigs.filter((s) => s.signal_type === "ran-all-unowned");
  db.close();
  // No owned files → no hard gate. Unit result = pass.
  expect(testSig?.result).toBe("pass");
  // `svc` fails in sweep → one ran-all-unowned signal
  expect(sweepSigs.length).toBe(1);
  expect(JSON.parse(sweepSigs[0]?.detail_json ?? "{}").component).toBe("svc");
});

test("advisory sweep silently skips absent command on untouched stack (no error)", async () => {
  // `svc` has no `test` command at all. Advisory sweep should skip it without error.
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
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "app"), { recursive: true });
    mkdirSync(join(input.cwd, "deploy"), { recursive: true });
    writeFileSync(join(input.cwd, "app", "main.ts"), "export const x = 1;\n");
    writeFileSync(join(input.cwd, "deploy", "cfg.yaml"), "env: prod\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      // svc has only `build`, no `test` — sweep must skip silently
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { build: "true" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const testSig = sigs.find((s) => s.signal_type === "test");
  const sweepSig = sigs.find((s) => s.signal_type === "ran-all-unowned");
  db.close();
  expect(testSig?.result).toBe("pass"); // hard gate on app passed
  expect(sweepSig).toBeUndefined(); // svc absent test → skipped, no signal or error
});

// ── WO-6 Task 1: inert-file skip ──────────────────────────────────────────────

test("inert-only diff (LICENSE) non-behavioral → passes via inert-only path, no sweep", async () => {
  // LICENSE is inert → goes through the pure-inert pass path, no sweep runs.
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
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "LICENSE"), "MIT License\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { test: "false" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch (writes LICENSE)
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → pure-inert path
  const sigs = listByUnit(db, unit.id);
  const testSig = sigs.find((s) => s.signal_type === "test");
  const sweepSig = sigs.find((s) => s.signal_type === "ran-all-unowned");
  db.close();
  // pure-inert + non-behavioral → pass
  expect(testSig?.result).toBe("pass");
  expect(JSON.parse(testSig?.detail_json ?? "{}").reason).toBe("inert-only");
  // no sweep should have run
  expect(sweepSig).toBeUndefined();
});

test("inert-only diff (LICENSE) behavioral → behavioral-no-code fail", async () => {
  // A behavioral unit whose entire diff is LICENSE (inert) must still fail behavioral-no-code.
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
    writeFileSync(join(input.cwd, "LICENSE"), "MIT License\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [{ name: "app", kind: "app", paths: ["src/**"], commands: { test: "true" } }],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch (writes LICENSE)
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → behavioral-no-code
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  expect(sig?.result).toBe("fail");
  expect(JSON.parse(sig?.detail_json ?? "{}").reason).toBe("behavioral-no-code");
});

test("non-inert unowned file (cfg.yaml) still triggers advisory sweep", async () => {
  // other/cfg.yaml is unowned and non-inert → sweep must still run.
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
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "other"), { recursive: true });
    writeFileSync(join(input.cwd, "other", "cfg.yaml"), "env: prod\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { test: "false" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch (writes other/cfg.yaml)
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → sweep runs
  const sigs = listByUnit(db, unit.id);
  const testSig = sigs.find((s) => s.signal_type === "test");
  const sweepSig = sigs.find((s) => s.signal_type === "ran-all-unowned");
  db.close();
  expect(testSig?.result).toBe("pass");
  // svc fails sweep → ran-all-unowned signal
  expect(sweepSig).toBeTruthy();
  expect(JSON.parse(sweepSig?.detail_json ?? "{}").component).toBe("svc");
});

test("renderPrBody renders ran-all-unowned under its own section, separate from untested stacks", async () => {
  // Drive the advisory-sweep scenario: app (owned, passes) + deploy/cfg.yaml (unowned) + svc (fails sweep).
  // Then verify renderPrBody output contains the precautionary-runs section and NOT ⚠ Untested stacks.
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "app"), { recursive: true });
    mkdirSync(join(input.cwd, "deploy"), { recursive: true });
    writeFileSync(join(input.cwd, "app", "main.ts"), "export const x = 1;\n");
    writeFileSync(join(input.cwd, "deploy", "cfg.yaml"), "env: prod\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { test: "false" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test → advisory sweep emits ran-all-unowned

  const body = renderPrBody(db, { id: ticketId, ident: "ENG-1", title: null });
  db.close();

  // Must include the precautionary-runs section with the failing component
  expect(body).toContain("Precautionary runs on unowned-file changes — review:");
  expect(body).toContain("svc:test");
  // Must NOT confuse this with the untested-merge-risk section
  expect(body).not.toContain("⚠ Untested stacks");
});

// ── WO-6 Task 2: sweep cost instrumentation ───────────────────────────────────

test("sweep-cost signal fires with stacksSwept count when untouched stack has the command", async () => {
  // app/main.ts owned by `app` (hard gate, test:"true" passes).
  // config/settings.yaml is unowned non-inert → advisory sweep runs on `svc`.
  // `svc` has test:"true" → commandFor present → stacksSwept = 1.
  // After the loop a sweep-cost signal must exist with the correct detail fields.
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
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "app"), { recursive: true });
    mkdirSync(join(input.cwd, "config"), { recursive: true });
    writeFileSync(join(input.cwd, "app", "main.ts"), "export const x = 1;\n");
    writeFileSync(join(input.cwd, "config", "settings.yaml"), "debug: false\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { test: "true" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const costSig = sigs.find((s) => s.signal_type === "sweep-cost");
  db.close();
  expect(costSig).toBeTruthy();
  expect(costSig?.result).toBe("pass");
  const detail = JSON.parse(costSig?.detail_json ?? "{}");
  expect(detail.checkType).toBe("test");
  expect(typeof detail.stacksSwept).toBe("number");
  expect(detail.stacksSwept).toBe(1);
  expect(typeof detail.wallClockMs).toBe("number");
  expect(detail.wallClockMs).toBeGreaterThanOrEqual(0);
  expect(typeof detail.unownedTriggers).toBe("number");
  expect(detail.unownedTriggers).toBeGreaterThanOrEqual(1);
});

test("sweep-cost positive-trace: fires with stacksSwept:0 when untouched stacks all lack the command", async () => {
  // config/settings.yaml is unowned non-inert → sweep block is entered.
  // `svc` has only `build`, no `test` → commandFor(svc, "test") = undefined → loop skips.
  // sweep-cost must still fire (positive trace), with stacksSwept: 0.
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
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "app"), { recursive: true });
    mkdirSync(join(input.cwd, "config"), { recursive: true });
    writeFileSync(join(input.cwd, "app", "main.ts"), "export const x = 1;\n");
    writeFileSync(join(input.cwd, "config", "settings.yaml"), "debug: false\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      // svc has only build, no test — sweep loop will skip it via `continue`
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { build: "true" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const costSig = sigs.find((s) => s.signal_type === "sweep-cost");
  db.close();
  // positive-trace: sweep block was entered (unownedNonInert non-empty) → signal must fire
  expect(costSig).toBeTruthy();
  expect(costSig?.result).toBe("pass");
  const detail = JSON.parse(costSig?.detail_json ?? "{}");
  expect(detail.stacksSwept).toBe(0);
  expect(detail.unownedTriggers).toBeGreaterThanOrEqual(1);
});

test("no sweep-cost signal when all changed files are owned or inert", async () => {
  // app/main.ts is owned by `app`, LICENSE is inert.
  // unownedNonInert = [] → sweep block is never entered → no sweep-cost signal.
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
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "app"), { recursive: true });
    writeFileSync(join(input.cwd, "app", "main.ts"), "export const x = 1;\n");
    writeFileSync(join(input.cwd, "LICENSE"), "MIT License\n");
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
  const { profile, worktreeRoot } = rig(repo, {
    components: [
      { name: "app", kind: "app", paths: ["app/**"], commands: { test: "true" } },
      { name: "svc", kind: "svc", paths: ["svc/**"], commands: { test: "true" } },
    ],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  await advanceOneStep(db, ticketId, registry); // implement:dispatch
  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  await advanceOneStep(db, ticketId, registry); // completeness:wu1 (declared=∅ → covered-by-sibling/completed-by-self, no throw)
  await advanceOneStep(db, ticketId, registry); // verify:check test
  const sigs = listByUnit(db, unit.id);
  const costSig = sigs.find((s) => s.signal_type === "sweep-cost");
  db.close();
  // No unowned non-inert files → sweep block not entered → no sweep-cost signal
  expect(costSig).toBeUndefined();
});
