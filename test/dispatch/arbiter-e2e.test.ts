import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import {
  insertAcCheck,
  listByTicket as listAcCheckRows,
  listActiveByTicket as listActiveAcChecks,
} from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { insertSignal, latestReauthorAtSha } from "../../src/db/repos/ground-truth-signal.ts";
import type { RegistryDeps } from "../../src/dispatch/handlers.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): { root: string; initSha: string } {
  const root = mkdtempSync(join(tmpdir(), "styre-arb-e2e-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  const initSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root })
    .stdout.toString()
    .trim();
  return { root, initSha };
}

function registryWith(
  repo: string,
  runner: FakeAgentRunner,
  runCheckCommand: RegistryDeps["runCheckCommand"],
) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb-e2e-wt-")),
    runCheckCommand,
  });
}

/** A scripted checks:dispatch-shaped author response: writes a new added test file into `input.cwd`
 *  and echoes a `checksAuthored` sidecar for `acId`. */
function authorResponse(acId: number, testFile: string, testName: string, body: string) {
  return (input: { cwd: string }) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, testFile.split("/").pop() as string), body);
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [{ ac_id: acId, test_file: testFile, test_name: testName }],
      })}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  };
}

/** A scripted checks:classify-shaped response: classifies whatever `ac_check_id` the prompt echoes
 *  as `cls`. */
function classifyResponse(cls: string, reason: string) {
  return (input: { prompt: string }) => {
    const m = input.prompt.match(/ac_check_id=(\d+)/);
    const id = m ? Number(m[1]) : 0;
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n${JSON.stringify({
        classifications: [{ ac_check_id: id, class: cls, reason }],
      })}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  };
}

function isClassifyPrompt(prompt: string): boolean {
  return prompt.includes("adjudicat") || prompt.includes("Checks to classify");
}

test("checks:reauthor: RED-first-valid + assertion-classified re-author installs (supersede old, insert new active, fresh red-first at the reauthor sha)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo, initSha } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ? WHERE id = ?").run("ENG-1", ticketId);

  const ac = insertAc(db, { ticketId, seq: 1, text: "persists a pref", source: "checklist" });
  const oldCheck = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "checks/old_test.py::test_old",
    testPath: "checks/old_test.py",
    redFirstResult: "red",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    branchHeadSha: initSha, // §5.2: the frozen clean-HEAD baseline
    detail: {
      rawOutput: "",
      exitCode: 1,
      framework: "pytest",
      command: null,
      acCheckId: oldCheck.id,
    },
  });

  const roundSha = "ROUND-SHA-1";
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "reauthor", // FIX I1: NOT "checks" — a distinct label from the design-stage re-author loop.
    routeTo: "checks:reauthor",
    signature: `arbiter:${ac.id}`,
    payload: { acIds: [ac.id], sha: roundSha },
  });

  const runner = new FakeAgentRunner((input) => {
    if (isClassifyPrompt(input.prompt)) {
      return classifyResponse("assertion", "real behavioral assert")(input);
    }
    return authorResponse(
      ac.id,
      "checks/new_test.py",
      "test_new",
      "def test_new():\n    assert save_pref() == 1\n",
    )(input);
  });

  // RED at the baseline replay (pytest exit 1).
  const registry = registryWith(repo, runner, async () => ({
    exitCode: 1,
    stdout: "1 failed",
    stderr: "",
    timedOut: false,
  }));

  const handler = registry.resolve("checks:reauthor");
  if (!handler) throw new Error("checks:reauthor handler not registered");
  await runStep(db, {
    ticketId,
    stepKey: "checks:reauthor",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      handler({
        db,
        ticket: {
          id: ticketId,
          ident: "ENG-1",
          title: null,
          project_id: projectId,
          stage: "implement",
        } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });

  const allChecks = listAcCheckRows(db, ticketId);
  const oldRow = allChecks.find((c) => c.id === oldCheck.id);
  const active = listActiveAcChecks(db, ticketId);
  const dispositions = latestReauthorAtSha(db, ticketId, roundSha);
  db.close();

  expect(oldRow?.superseded_at).not.toBeNull(); // the old (check-wrong) generation is superseded
  expect(active.length).toBe(1);
  expect(active[0]?.id).not.toBe(oldCheck.id); // a fresh row, never the superseded id
  expect(active[0]?.red_class).toBe("assertion");
  expect(dispositions).toEqual([{ acId: ac.id, acCheckId: oldCheck.id, disposition: "installed" }]);
});

test("checks:reauthor: a re-author that GREENS at the baseline replay is rejected — the old check stays active, no supersede", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo, initSha } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ? WHERE id = ?").run("ENG-1", ticketId);

  const ac = insertAc(db, { ticketId, seq: 1, text: "persists a pref", source: "checklist" });
  const oldCheck = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "checks/old_test.py::test_old",
    testPath: "checks/old_test.py",
    redFirstResult: "red",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    branchHeadSha: initSha,
    detail: {
      rawOutput: "",
      exitCode: 1,
      framework: "pytest",
      command: null,
      acCheckId: oldCheck.id,
    },
  });

  const roundSha = "ROUND-SHA-1";
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "reauthor",
    routeTo: "checks:reauthor",
    signature: `arbiter:${ac.id}`,
    payload: { acIds: [ac.id], sha: roundSha },
  });

  const runner = new FakeAgentRunner((input) => {
    if (isClassifyPrompt(input.prompt)) {
      // Should never be reached: a green-at-baseline replay rejects BEFORE classification.
      throw new Error("unexpected classify dispatch on a green-at-baseline re-author");
    }
    return authorResponse(
      ac.id,
      "checks/new_test.py",
      "test_new",
      "def test_new():\n    assert True\n",
    )(input);
  });

  // GREEN at the baseline replay (pytest exit 0) — the RED-first oracle rejects.
  const registry = registryWith(repo, runner, async () => ({
    exitCode: 0,
    stdout: "1 passed",
    stderr: "",
    timedOut: false,
  }));

  const handler = registry.resolve("checks:reauthor");
  if (!handler) throw new Error("checks:reauthor handler not registered");
  await runStep(db, {
    ticketId,
    stepKey: "checks:reauthor",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      handler({
        db,
        ticket: {
          id: ticketId,
          ident: "ENG-1",
          title: null,
          project_id: projectId,
          stage: "implement",
        } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });

  const allChecks = listAcCheckRows(db, ticketId);
  const oldRow = allChecks.find((c) => c.id === oldCheck.id);
  const active = listActiveAcChecks(db, ticketId);
  const dispositions = latestReauthorAtSha(db, ticketId, roundSha);
  db.close();

  expect(oldRow?.superseded_at).toBeNull(); // NOT superseded — no silent pass
  expect(active.length).toBe(1);
  expect(active[0]?.id).toBe(oldCheck.id); // the old check is still the (only) active one
  expect(dispositions).toEqual([{ acId: ac.id, acCheckId: oldCheck.id, disposition: "rejected" }]);
});
