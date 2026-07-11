import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { insertWorkUnit, setStatus as setUnitStatus } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { resolvePythonInterpreter } from "../../src/dispatch/provision.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-int-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

/** Seed db so the ticket is ready for verify:integration (all units verified). */
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

test("verify:integration runs all components' build+test + repoCommands and records pass with detail.ran", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  seedAllVerified(db, ticketId, projectId, repo);

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
          kind: "backend",
          paths: ["api/**"],
          commands: { build: "true", test: "true" },
        },
        {
          name: "web",
          kind: "frontend",
          paths: ["web/**"],
          commands: { build: "true", test: "true" },
        },
      ],
      repoCommands: { integration: "true" },
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-int-wt-")),
  });

  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  const outcome = await advanceOneStep(db, ticketId, registry);
  const step = getByKey(db, ticketId, "verify:integration");
  const sigs = db
    .query(
      "SELECT signal_type, result, detail_json FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'",
    )
    .all(ticketId) as Array<{ signal_type: string; result: string; detail_json: string }>;
  db.close();

  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(sigs).toHaveLength(1);
  expect(sigs[0]?.result).toBe("pass");

  const detail = JSON.parse(sigs[0]?.detail_json ?? "{}") as { ran: Array<{ label: string }> };
  const labels = detail.ran.map((r) => r.label);
  // Each component's build and test, plus the repoCommand
  expect(labels).toContain("api:build");
  expect(labels).toContain("api:test");
  expect(labels).toContain("web:build");
  expect(labels).toContain("web:test");
  expect(labels).toContain("repo:integration");
  expect(labels).toHaveLength(5);
});

test("verify:integration records an advisory fail when one component's test command fails, and the step SUCCEEDS (M4 demotion)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  seedAllVerified(db, ticketId, projectId, repo);

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
          kind: "backend",
          paths: ["api/**"],
          commands: { build: "true", test: "true" },
        },
        {
          name: "web",
          kind: "frontend",
          paths: ["web/**"],
          commands: { build: "true", test: "false" }, // failing test
        },
      ],
      repoCommands: { integration: "true" },
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-int-fail-")),
  });

  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:integration → advisory fail, step succeeds
  const sigs = db
    .query(
      "SELECT result, detail_json FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'",
    )
    .all(ticketId) as Array<{ result: string; detail_json: string }>;
  db.close();

  expect(outcome.kind).toBe("stepped"); // never throws — the integration verdict is advisory (M4 §8c)
  expect(sigs[0]?.result).toBe("fail");
  expect(JSON.parse(sigs[0]?.detail_json ?? "{}").advisory).toBe(true);
});

// --- Task 3: verify:integration test-job command resolution routes through reuseAwareTestCommand ---

test("verify:integration test command for a python component with no ready env falls back to the configured harness unchanged", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo(); // no pyproject.toml / editable install anywhere → never provably "ready"
  seedAllVerified(db, ticketId, projectId, repo);

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
      // kind: "python" + key "test" is exactly what reuseAwareTestCommand self-gates on; "tox"
      // here is the "detected harness" that must survive unchanged when reuse isn't proven.
      components: [
        { name: "py", kind: "python", paths: ["**"], commands: { build: "true", test: "tox" } },
      ],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-int-pynoready-")),
  });

  await advanceOneStep(db, ticketId, registry); // provision (no prepare configured -> no-op)
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:integration
  const sigs = db
    .query(
      "SELECT result, command, detail_json FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'",
    )
    .all(ticketId) as Array<{ result: string; command: string; detail_json: string }>;
  db.close();

  // "tox" isn't a real binary here, but the integration verdict is advisory (M4 §8c) — no throw.
  expect(outcome.kind).toBe("stepped");
  const detail = JSON.parse(sigs[0]?.detail_json ?? "{}") as {
    ran: Array<{ label: string; exitCode: number | null }>;
  };
  const buildJob = detail.ran.find((r) => r.label === "py:build");
  expect(buildJob?.exitCode).toBe(0); // build job untouched, ran the detected "true"
});

// RUN_LIVE-gated: exercises the real reuse resolver end to end through verify:integration — a
// real editable pip install (via the existing `provision` step) makes the python env provably
// ready, so the test job must run pytest directly instead of the configured "false" harness
// (which would fail the step if it ran unchanged — the strongest possible proof the wiring is
// live, not mocked). Mirrors the pattern in test/dispatch/verify-handlers.test.ts (Task 2).
const live = process.env.RUN_LIVE === "1" ? test : test.skip;

live(
  "verify:integration: a ready python env resolves the test job to pytest, not the configured harness",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-int-pyready-"));
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
      seedAllVerified(db, ticketId, projectId, root);

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
        worktreeRoot: mkdtempSync(join(tmpdir(), "styre-int-pyreadywt-")),
      });

      await advanceOneStep(db, ticketId, registry); // provision → real editable install (env → ready)
      const outcome = await advanceOneStep(db, ticketId, registry); // verify:integration → pytest
      const sigs = db
        .query(
          "SELECT result, command FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'",
        )
        .all(ticketId) as Array<{ result: string; command: string }>;
      db.close();

      expect(outcome.kind).toBe("stepped");
      expect(sigs[0]?.result).toBe("pass");
      expect(sigs[0]?.command).toBe(`${interp} -m pytest`);
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
