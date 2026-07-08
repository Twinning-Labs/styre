import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByTicket as listAcChecks } from "../../src/db/repos/ac-check.ts";
import { listByTicket as listSignals } from "../../src/db/repos/ground-truth-signal.ts";
import { setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-ch-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

// Drive the loop until it steps `checks:dispatch` (design:dispatch done + a unit + fast track already set).
async function markDesignDone(db: Parameters<typeof runStep>[0], ticketId: number) {
  await runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => ({ ok: true }),
  });
}

test("checks:dispatch authors, verifies identity, runs RED-first, and persists a coarse red", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  // A checklist description → deriveAndPersistAcs yields two ACs.
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] returns ok\n- [ ] rejects bad input\n",
    ticketId,
  );
  // Force the resolver to the design→(provision→checks)→implement seam:
  //   design:dispatch done + one unit + track=fast (skips review) → provision, then checks:dispatch.
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // The agent authors one NEW test file per AC and returns the sidecar. ac_id = the AC DB ids (1,2).
  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ac1.py"), "def test_ac1():\n    assert False\n");
    writeFileSync(join(dir, "ac2.py"), "def test_ac2():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ac1.py","test_name":"test_ac1"},' +
        '{"ac_id":2,"test_file":"checks/ac2.py","test_name":"test_ac2"}' +
        "]}\n```",
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
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt-")),
    // Inject the RED-first runner: a failing (red) run for every check (decision 4).
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });

  // The loop collapses design→provision (no prepare → no-op) then steps checks:dispatch.
  let outcome = await advanceOneStep(db, ticketId, registry); // provision
  outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch
  const checks = listAcChecks(db, ticketId);
  const signals = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-red-first");
  const step = getByKey(db, ticketId, "checks:dispatch");
  db.close();

  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(checks.length).toBe(2);
  expect(checks.every((c) => c.red_first_result === "red")).toBe(true);
  expect(checks.every((c) => c.selector !== "" && c.test_path !== null)).toBe(true);
  // Vocab map (§9): red → fail in ground_truth_signal (never 'red').
  expect(signals.length).toBe(2);
  expect(signals.every((s) => s.result === "fail")).toBe(true);
});

test("checks:dispatch rejects a MODIFIED file (identity: added-only) → postcondition fails", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] one thing\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // The agent EDITS the pre-existing README.md instead of adding a new file → identity reject.
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "README.md"), "edited\ndef test_x(): pass\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"README.md","test_name":"test_x"}]}\n```',
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
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt2-")),
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });
  await advanceOneStep(db, ticketId, registry); // provision
  const outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch → postcondition fail
  const step = getByKey(db, ticketId, "checks:dispatch");
  const checks = listAcChecks(db, ticketId);
  db.close();
  // No AC covered → postcondition throws → failure-policy (retry/escalate), nothing persisted.
  // `checks:dispatch` is a generic "dispatch"-type step (not verify/completeness/provision), so a
  // first-attempt failure falls to failure-policy's default branch: bounded retry, reset to
  // 'pending' (mirrors "a failing handler routes through failure-policy (retry)" in advance.test.ts —
  // NOT 'failed', which only survives when maxAttempts is already exhausted at entry).
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(checks.length).toBe(0);
});
