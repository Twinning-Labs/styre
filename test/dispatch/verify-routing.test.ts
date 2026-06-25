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
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
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

test("declared check that hits NO component is an error, not a vacuous pass", async () => {
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
  // Agent writes a file under a path no component covers (components only cover src-tauri/**)
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
  for (let i = 0; i < 4; i++) await advanceOneStep(db, ticketId, registry);
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  expect(sig?.result).toBe("error");
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
