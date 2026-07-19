import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
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
