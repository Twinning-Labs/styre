import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { buildVerifyReport, renderVerifyReport } from "../../src/dispatch/verify-report.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-e2e-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("real design:dispatch handler (fake agent) commits a plan and the step succeeds", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "docs", "plans");
    Bun.spawnSync(["mkdir", "-p", dir]);
    writeFileSync(join(dir, "ENG-1-plan.md"), "---\nlinear: ENG-1\n---\nplan\n");
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
    profile: parseProfile({ slug: "demo", targetRepo: repo, promptVars: { stack: "bun" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-e2ewt-")),
  });

  // provision is hoisted to the top of case "design" — it runs first (a no-op here: the profile
  // has no components, so planProvision installs nothing). design:dispatch runs next.
  const provisionOutcome = await advanceOneStep(db, ticketId, registry);
  expect(provisionOutcome).toEqual({ kind: "stepped", stepKey: "provision" });
  const outcome = await advanceOneStep(db, ticketId, registry);
  db.close();
  expect(outcome).toEqual({ kind: "stepped", stepKey: "design:dispatch" });
});

test("ENG-412: a component skipped for want of a toolchain reaches the PR advisory, not just stderr", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);

  const registry = buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("the agent must not be reached — provision runs first");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    // The profile is ALREADY narrowed, exactly as `styre run` hands it over: `frontend` is gone
    // from components and survives only in `unusableComponents`.
    profile: parseProfile({ slug: "demo", targetRepo: repo }),
    unusableComponents: [
      {
        component: "frontend",
        missing: [
          { component: "frontend", label: "prepare", command: "npm install", missing: "npm" },
        ],
      },
    ],
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-e2ewt-")),
  });

  expect(await advanceOneStep(db, ticketId, registry)).toEqual({
    kind: "stepped",
    stepKey: "provision",
  });

  // The whole path, not a piece of it: deps -> insertSignal -> advisorySweeps -> report -> markdown.
  const report = buildVerifyReport(db, ticketId);
  const unusable = report.advisory.filter((a) => a.kind === "component-unusable");
  expect(unusable).toHaveLength(1);

  const markdown = renderVerifyReport(report);
  expect(markdown).toContain("`frontend`");
  expect(markdown).toContain("`npm`");
  expect(markdown).toContain("unverified");
  db.close();
});

test("ENG-412: a run that skipped nothing writes no toolchain advisory at all", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);

  const registry = buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("the agent must not be reached — provision runs first");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-e2ewt-")),
  });

  await advanceOneStep(db, ticketId, registry);

  const report = buildVerifyReport(db, ticketId);
  expect(report.advisory.filter((a) => a.kind === "component-unusable")).toHaveLength(0);
  db.close();
});

test("ENG-425: a non-primary component reaches the PR advisory through the real dispatch path", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);

  const registry = buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("the agent must not be reached — provision runs first");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    // Already narrowed, exactly as `styre run` hands it over: the decoy is gone from components
    // and survives only in `nonPrimaryComponents`.
    profile: parseProfile({ slug: "demo", targetRepo: repo }),
    nonPrimaryComponents: [
      {
        component: "extra-setup-py.test",
        role: "fixture",
        label: "legacy stub package (py.test name reservation, sdist-only, no real tests)",
      },
    ],
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-e2ewt-")),
  });

  expect(await advanceOneStep(db, ticketId, registry)).toEqual({
    kind: "stepped",
    stepKey: "provision",
  });

  // The whole path: deps -> insertSignal -> advisorySweeps -> report -> markdown. A unit test of
  // the renderer would pass with the emission deleted — the gap that let mutations survive in
  // ENG-412 and ENG-419.
  const report = buildVerifyReport(db, ticketId);
  expect(report.advisory.filter((a) => a.kind === "component-not-primary")).toHaveLength(1);

  const markdown = renderVerifyReport(report);
  expect(markdown).toContain("`extra-setup-py.test`");
  expect(markdown).toContain("fixture");
  expect(markdown).toContain("not part of the product");
  db.close();
});

test("ENG-425 + ENG-412: both narrowings survive together; neither signal overwrites the other", async () => {
  // `advisorySweeps` keys by signal_type and keeps only the newest per key. These are emitted
  // under different types precisely so both reach the PR — this is the writer's half of that
  // contract, and it is the half a renderer test cannot check.
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);

  const registry = buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("the agent must not be reached — provision runs first");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo }),
    unusableComponents: [
      {
        component: "frontend",
        missing: [
          { component: "frontend", label: "prepare", command: "npm install", missing: "npm" },
        ],
      },
    ],
    nonPrimaryComponents: [{ component: "demo", role: "example" }],
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-e2ewt-")),
  });

  await advanceOneStep(db, ticketId, registry);

  const report = buildVerifyReport(db, ticketId);
  expect(report.advisory.filter((a) => a.kind === "component-unusable")).toHaveLength(1);
  expect(report.advisory.filter((a) => a.kind === "component-not-primary")).toHaveLength(1);

  const markdown = renderVerifyReport(report);
  expect(markdown).toContain("`frontend`");
  expect(markdown).toContain("`demo` (example)");
  db.close();
});
