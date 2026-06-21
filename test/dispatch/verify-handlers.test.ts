import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
