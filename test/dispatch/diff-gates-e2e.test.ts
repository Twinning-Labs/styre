import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByUnit } from "../../src/db/repos/ground-truth-signal.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-dg-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("behavioral unit with no test file still verifies on the first attempt (A1 is advisory, M4 demotion)", async () => {
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

  // Single coding attempt, writes real code but no test file — A1 (behavioral-no-test) would have
  // thrown pre-M4; now it's an advisory fail and no bounce-back / second attempt ever happens.
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature.ts"), "export const v = 1;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["feature.ts"]}\n\`\`\``,
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-dgwt-")),
  });

  for (let i = 0; i < 12; i++) {
    if (getUnit(db, unit.id)?.status === "verified") break;
    await advanceOneStep(db, ticketId, registry);
  }
  const results = listByUnit(db, unit.id);
  const finalUnit = getUnit(db, unit.id);
  db.close();
  expect(finalUnit?.status).toBe("verified");
  const testSig = results.find((r) => r.signal_type === "test");
  expect(testSig?.result).toBe("fail"); // A1 behavioral-no-test — advisory, recorded but never gates
  expect(JSON.parse(testSig?.detail_json ?? "{}").reason).toBe("behavioral-no-test");
  expect(JSON.parse(testSig?.detail_json ?? "{}").advisory).toBe(true);
});

test("a failing integration suite is advisory and advances the ticket without spawning a reconcile unit (M4 §8c)", async () => {
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
    writeFileSync(join(input.cwd, "c.ts"), "export const v = 1;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["c.ts"]}\n\`\`\``,
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
        // build always fails — the integration suite is red for the whole run.
        { name: "app", kind: "app", paths: ["**"], commands: { test: "true", build: "false" } },
      ],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-dgint-")),
  });

  // Drive until the integration signal is recorded — checked at the top BEFORE each tick, so we
  // stop before the tick that would advance implement→review (no review handler exists yet).
  const integrationRan = () =>
    (
      db
        .query(
          "SELECT COUNT(*) AS n FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'",
        )
        .get(ticketId) as { n: number }
    ).n > 0;
  for (let i = 0; i < 20; i++) {
    if (integrationRan()) break;
    await advanceOneStep(db, ticketId, registry);
  }
  const intSigs = db
    .query(
      "SELECT result, detail_json FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration' ORDER BY id",
    )
    .all(ticketId) as Array<{ result: string; detail_json: string }>;
  const reconcileUnits = db
    .query("SELECT kind FROM work_unit WHERE ticket_id = ? AND kind = 'reconcile'")
    .all(ticketId);
  db.close();
  // Advisory fail recorded — no throw, so failure-policy's integration-reconcile branch never fires.
  expect(intSigs.length).toBe(1);
  expect(intSigs[0]?.result).toBe("fail");
  expect(JSON.parse(intSigs[0]?.detail_json ?? "{}").advisory).toBe(true);
  expect(reconcileUnits.length).toBe(0);
});
