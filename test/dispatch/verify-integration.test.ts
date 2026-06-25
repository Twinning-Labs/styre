import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { insertWorkUnit, setStatus as setUnitStatus } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
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

test("verify:integration fails when one component's test command fails", async () => {
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
