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

test("a unit whose suite fails on the first attempt still ends verified (advisory, M4 demotion — no bounce-back retry)", async () => {
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

  // The profile test command always fails — the marker file it checks for is never written.
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "change.ts"), "export const v = 1;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["change.ts"]}\n\`\`\``,
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
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "test -f PASS" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vrwt-")),
  });

  for (let i = 0; i < 12; i++) {
    if (getUnit(db, unit.id)?.status === "verified") break;
    await advanceOneStep(db, ticketId, registry);
  }
  const results = listByUnit(db, unit.id);
  const finalUnit = getUnit(db, unit.id);
  db.close();
  // Demoted (M4 §8a/§8b): the suite verdict never gates — the unit reaches verified on the ONE
  // coding attempt, with the advisory fail on record (no automatic retry occurs).
  expect(finalUnit?.status).toBe("verified");
  const testSig = results.find((r) => r.signal_type === "test");
  expect(testSig?.result).toBe("fail");
  expect(JSON.parse(testSig?.detail_json ?? "{}").advisory).toBe(true);
});
