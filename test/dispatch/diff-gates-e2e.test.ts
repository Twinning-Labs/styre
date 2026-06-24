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

test("behavioral unit converges after the add-a-test bounce-back", async () => {
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

  let attempt = 0;
  const runner = new FakeAgentRunner((input) => {
    attempt += 1;
    writeFileSync(join(input.cwd, `feature-${attempt}.ts`), `export const v = ${attempt};\n`);
    if (attempt >= 2) writeFileSync(join(input.cwd, "feature.test.ts"), "test('v', () => {});\n");
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
  expect(results.some((r) => r.signal_type === "test" && r.result === "fail")).toBe(true); // the A1 failure kept
  expect(results.some((r) => r.signal_type === "test" && r.result === "pass")).toBe(true);
});

test("integration fails then a reconcile unit makes it pass", async () => {
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

  // Integration command passes only once a RECONCILE marker file exists; the reconcile unit writes it.
  let coded = 0;
  const runner = new FakeAgentRunner((input) => {
    coded += 1;
    writeFileSync(join(input.cwd, `c-${coded}.ts`), `export const v = ${coded};\n`);
    // The reconcile unit (2nd+ coding) writes the marker that makes integration pass.
    if (coded >= 2) writeFileSync(join(input.cwd, "RECONCILED"), "ok");
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
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [
        {
          name: "app",
          kind: "app",
          paths: ["**"],
          commands: { test: "true", build: "test -f RECONCILED || test -f STOP" },
        },
      ],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-dgint-")),
  });

  // Drive until integration PASSES — checked at the top BEFORE each tick, so we stop before the
  // tick that would advance implement→review (no review handler exists yet; that would throw).
  const integrationPassed = () =>
    (
      db
        .query(
          "SELECT COUNT(*) AS n FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration' AND result = 'pass'",
        )
        .get(ticketId) as { n: number }
    ).n > 0;
  for (let i = 0; i < 20; i++) {
    if (integrationPassed()) break;
    await advanceOneStep(db, ticketId, registry);
  }
  const intSigs = db
    .query(
      "SELECT result, branch_head_sha FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration' ORDER BY id",
    )
    .all(ticketId) as Array<{ result: string; branch_head_sha: string | null }>;
  db.close();
  // integration failed at least once, then passed at a later commit (after the reconcile unit).
  expect(intSigs.some((s) => s.result === "fail")).toBe(true);
  expect(intSigs.some((s) => s.result === "pass")).toBe(true);
  expect(new Set(intSigs.map((s) => s.branch_head_sha)).size).toBeGreaterThan(1);
});
