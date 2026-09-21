import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { listByTicket } from "../../src/db/repos/ground-truth-signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

test("resume with completed provision still rejects changed environment before design dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "styre-env-resume-"));
  const { db, ticketId, projectId } = makeTestDb();
  try {
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.email", "test@styre.invalid"],
      ["config", "user.name", "Test"],
    ])
      expect(Bun.spawnSync(["git", ...args], { cwd: root }).exitCode).toBe(0);
    writeFileSync(join(root, "pytest.ini"), "[pytest]\n");
    Bun.spawnSync(["git", "add", "."], { cwd: root });
    Bun.spawnSync(["git", "commit", "-m", "fixture"], { cwd: root });
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(root, projectId);
    insertPending(db, { ticketId, stepKey: "provision", stepType: "provision" });
    db.query(
      "UPDATE workflow_step SET status='succeeded' WHERE ticket_id=? AND step_key='provision'",
    ).run(ticketId);
    const step = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
    const runner = new FakeAgentRunner(() => {
      throw Error("agent must not run");
    });
    const profile = parseProfile({
      slug: "fixture",
      targetRepo: root,
      components: [
        {
          name: "app",
          kind: "python",
          paths: ["**"],
          commands: { test: "python3 -m pytest" },
          testAction: { framework: "pytest", launcher: "python3 -m pytest" },
          testEnvironment: {
            version: 1,
            policy: "existing",
            adapter: "python",
            suiteCommand: "python3 -m pytest",
            framework: "pytest",
            checkLauncher: "python3 -m pytest",
          },
        },
      ],
    });
    const registry = buildDispatchRegistry({
      runner,
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile,
      inPlace: true,
      worktreeRoot: root,
      runCheckCommand: async () => ({
        stdout: "",
        stderr: "interpreter missing",
        exitCode: 127,
        timedOut: false,
      }),
    });
    const ticket = getTicket(db, ticketId);
    const handler = registry.resolve("design:dispatch");
    if (!ticket || !handler) throw Error("missing fixture");
    await expect(
      handler({
        db,
        ticket,
        step,
        workUnitId: null,
        config: DEFAULT_RUNTIME_CONFIG,
      }),
    ).rejects.toThrow("Test environment");
    expect(runner.inputs).toHaveLength(0);
    expect(
      listByTicket(db, ticketId).some(
        (s) => s.signal_type === "test-environment" && s.result === "error",
      ),
    ).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
